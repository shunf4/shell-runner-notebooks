// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { PowerShellNotebookSerializer } from './PowerShellNotebookSerializer';
import { ShNotebookSerializer, COMMON_MERGICIAN } from './ShNotebookSerializer';
import { NotebookSerializer } from './NotebookSerializer';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { TextEncoder } from 'util';
import * as which from 'which';
import * as os from 'os';

const VAR_MAP_REPLACE_REGEX = new RegExp(/\[\[\[([^:]+):(.*?)\]\]\]/g);
const VAR_MAP_REPLACE_REGEX_2 = new RegExp(/<<<([^:]+):(.*?)>>>/g);

async function replaceAsync(str: any, regex: any, asyncFn: any) {
    const promises: any[] = [];
    str.replace(regex, (full: any, ...args: any) => {
        promises.push(asyncFn(full, ...args));
        return full;
    });
    const data = await Promise.all(promises);
    return str.replace(regex, () => data.shift());
}

async function replaceWithVarMap(varMap: any, theStr: string): Promise<string> {
	const commonVarReplaceFunc = async (wholeMatch: string, varKey: any, varDefaultVal: any) => {
		if (typeof varDefaultVal === 'string') {
			if (varDefaultVal.startsWith('which(') && varDefaultVal.endsWith(')')) {
				varDefaultVal = varDefaultVal.substring('which('.length, varDefaultVal.length - ')'.length);
				varDefaultVal = await which(varDefaultVal);
			}
		}
		return ((varMap ?? {})[varKey] ?? varDefaultVal);
	};

	return await replaceAsync(await replaceAsync(theStr, VAR_MAP_REPLACE_REGEX, commonVarReplaceFunc), VAR_MAP_REPLACE_REGEX_2, commonVarReplaceFunc);
}

function getExecuteHandler(controller: vscode.NotebookController, defaultExtTermRunConfParam: string | undefined) {
	return async (cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument) => {
		if (!vscode.window.activeTerminal) {
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
		}

		const configPatch = vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfigPatch");
		const configExtraPatch1 = (vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfigExtraHostnamePatchMap") ?? {} as any)[os.hostname()] ?? {};
		const configExtraPatch2 = (vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfigExtraEnvPatchMap") ?? {} as any)[process.env["SHELL_RUNNER_NOTEBOOKS_ENV"] || ''] ?? {};

		const defaultConfigOverwriteByFile = (configExtraPatch2??{} as any)["defaultConfigOverwriteByFile"] || (configExtraPatch1??{} as any)["defaultConfigOverwriteByFile"] || (configPatch??{} as any)["defaultConfigOverwriteByFile"];

		const config = await (async () => {
			try {
				if (defaultConfigOverwriteByFile) {
					const defConfigOverrideFileContent = await fs.promises.readFile(defaultConfigOverwriteByFile, {encoding: 'utf-8'});
					let defConfigOverrideJson = JSON.parse(defConfigOverrideFileContent);
					if (defConfigOverrideJson.contributes) {
						defConfigOverrideJson = defConfigOverrideJson.contributes.configuration.properties["shell-runner-notebooks.extTermConfig"].default;
					}
					return defConfigOverrideJson;
				}
			} catch (e) {
				console.error("ShellRunnerNotebooks: trying to read and parse defaultConfigOverwriteByFile", e);
			}

			return vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfig");
		})();

		const patchedConfig = COMMON_MERGICIAN(config, configPatch, configExtraPatch1, configExtraPatch2);

		let notebookGlobalExtTermOpts: any = {};
		let isHaveFirstCellAndHaveTermOpts: boolean = false;
		let savedFirstCellTermOpts: any = undefined;
		let isNotebookGlobalHaveTermOpts: boolean | undefined = undefined;

		if (notebook.cellCount > 0) {
			for (const firstCellLines of notebook.cellAt(0).document.getText().split('\n')) {
				const lTrimStart = firstCellLines.trimStart();
				if (lTrimStart !== '') {
					const parseFirstCellDirectiveResult = ShNotebookSerializer.parseExtTermDirective(lTrimStart, true, patchedConfig, defaultExtTermRunConfParam ?? "default");
					if ((parseFirstCellDirectiveResult.isLineExtTermDirective ?? false)) {
						isHaveFirstCellAndHaveTermOpts = true;
						savedFirstCellTermOpts = parseFirstCellDirectiveResult.cellExtTermOpts;
						if (parseFirstCellDirectiveResult.isDirectiveNotebookGlobal ?? false) {
							notebookGlobalExtTermOpts = savedFirstCellTermOpts;
							isNotebookGlobalHaveTermOpts = true;
						}
					} else {
						// has other line than directive, make isNotebookGlobalHaveTermOpts false if undefined
							if (isNotebookGlobalHaveTermOpts === undefined) {
								isNotebookGlobalHaveTermOpts = false;
							}
					}
				}
			}
			if (isNotebookGlobalHaveTermOpts === undefined
				&& isHaveFirstCellAndHaveTermOpts) {
				isNotebookGlobalHaveTermOpts = true;
				notebookGlobalExtTermOpts = savedFirstCellTermOpts ?? {};
			}
			if (isNotebookGlobalHaveTermOpts === false) {
				notebookGlobalExtTermOpts = {};
			}
		} else {
			isNotebookGlobalHaveTermOpts = false;
			isHaveFirstCellAndHaveTermOpts = false;
			notebookGlobalExtTermOpts = {};
		}

		if (cells.length > 3) {
			cells = cells.slice(0, 3);
		}

		let isExtTerm = false;
		if (isNotebookGlobalHaveTermOpts) {
			isExtTerm = true;
		}

		for (const cell of cells) {
			const execution = controller.createNotebookCellExecution(cell);
			execution.start();
			const cellContent = execution.cell.document.getText();

			let cellExtTermOpts: any = COMMON_MERGICIAN(notebookGlobalExtTermOpts, {});
			let runConfVariantIdent: string | undefined = undefined;

			const cellLines = cellContent.split('\n');
			const cellExtTermContentLines = [];
			const filteredCellContentLines = [];
			let nonSpaceMet = false;
			for (const l of cellLines) {
				const lTrimStart = l.trimStart();
				if (lTrimStart === '') {
					cellExtTermContentLines.push(l);
					filteredCellContentLines.push(l);
					continue;
				}
				let isLineExtTermDirective = false;
				let isLineDenyExtTermDirective = false;

				const parseExtTermResult = ShNotebookSerializer.parseExtTermDirective(
					lTrimStart,
					!nonSpaceMet,
					patchedConfig,
					defaultExtTermRunConfParam ?? 'default',
				);

				isLineExtTermDirective = parseExtTermResult.isLineExtTermDirective ?? isLineExtTermDirective;
				isLineDenyExtTermDirective = parseExtTermResult.isLineDenyExtTermDirective ?? isLineDenyExtTermDirective;
				runConfVariantIdent = parseExtTermResult.runConfVariantIdent ?? runConfVariantIdent;

				if (isLineExtTermDirective && parseExtTermResult.cellExtTermOpts !== undefined) {
					if (parseExtTermResult.isUsingDefault && isNotebookGlobalHaveTermOpts) {
						// Don't use default opt, because notebook has global opt
					} else {
						cellExtTermOpts = { ...cellExtTermOpts, ...parseExtTermResult.cellExtTermOpts };
					}
				}
				
				if (isLineExtTermDirective) {
					isExtTerm = true;
					filteredCellContentLines.push(l);
				} else if (isLineDenyExtTermDirective) {
					isExtTerm = false;
				} else {
					cellExtTermContentLines.push(l);
					filteredCellContentLines.push(l);
				}
				nonSpaceMet = true;
			}

			if (isExtTerm) {
				try {
					const termPath = cellExtTermOpts.extTermExecPath ?? notebook.metadata?.extTermExecPath ?? '';
					const extTermExecArgs = (cellExtTermOpts.extTermExecArgs ?? notebook.metadata?.extTermExecArgs ?? []) as string[];
					const extTermWindowsVerbatimArguments = cellExtTermOpts.extTermWindowsVerbatimArguments ?? notebook.metadata?.extTermWindowsVerbatimArguments ?? false;
					const extTermSpawnShell = cellExtTermOpts.extTermSpawnShell ?? notebook.metadata?.extTermSpawnShell ?? true;
					let extTermTempScriptExtension = ((cellExtTermOpts.extTermTempScriptExtension ?? notebook.metadata?.extTermTempScriptExtension) || 'sh') as string;
					if (typeof extTermTempScriptExtension === 'string' && extTermTempScriptExtension.length > 0 && extTermTempScriptExtension[0] === '.') {
						extTermTempScriptExtension = extTermTempScriptExtension.substring(1);
					}

					let extTermTempScriptEncoding = ((cellExtTermOpts.extTermTempScriptEncoding ?? notebook.metadata?.extTermTempScriptEncoding) || 'utf-8') as string;

					if (termPath && typeof termPath === 'string') {
						const tempScriptDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, "___ExtTermTmpScript");
						await vscode.workspace.fs.createDirectory(tempScriptDir);
						const tempScript = vscode.Uri.joinPath(tempScriptDir, "___externalTerminalTempScript." + extTermTempScriptExtension);
						await vscode.workspace.fs.writeFile(tempScript, Buffer.from(cellExtTermContentLines.join('\n'), extTermTempScriptEncoding as BufferEncoding));

						const varMap = {
							...(patchedConfig.varMap ?? {}),
							...(cellExtTermOpts.varMap ?? {}),
						};


						let effectiveCommand = termPath;
						effectiveCommand = await replaceWithVarMap(varMap, effectiveCommand);
						
						let effectiveArgs = [...extTermExecArgs];
						let effectiveArgsPatchInsertion0Index = effectiveArgs.indexOf("[[[PatchInsertion0]]]");
						let effectiveArgsPatchInsertion1Index = effectiveArgs.indexOf("[[[PatchInsertion1]]]");
						if (effectiveArgsPatchInsertion1Index <= effectiveArgsPatchInsertion0Index) {
							effectiveArgsPatchInsertion1Index = -1;
						}
						let alb0 = 0;
						let arb0 = effectiveArgsPatchInsertion0Index < 0 ? 0 : effectiveArgsPatchInsertion0Index;
						let alb1 = effectiveArgsPatchInsertion0Index < 0 ? arb0 : (arb0 + 1);
						let arb1 = effectiveArgsPatchInsertion1Index < 0 ? alb1 : effectiveArgsPatchInsertion1Index;
						let alb2 = effectiveArgsPatchInsertion1Index < 0 ? arb1 : (arb1 + 1);

						effectiveArgs = [
							...effectiveArgs.slice(alb0, arb0),
							...(cellExtTermOpts.extTermExecArgsPatchInsertion0 ?? []),
							...effectiveArgs.slice(alb1, arb1),
							...(cellExtTermOpts.extTermExecArgsPatchInsertion1 ?? []),
							...effectiveArgs.slice(alb2),
						];
						
						{
							const old = effectiveArgs;
							effectiveArgs = [];
							for (const x of old) {
								const replacedArgs = await replaceWithVarMap(varMap, x);
								if (replacedArgs !== '(((ShNb:CancelArg)))' && replacedArgs !== '{{{ShNb:CancelArg}}}') {
									effectiveArgs.push(replacedArgs);
								}
							}
						}
						effectiveArgs.push(tempScript.fsPath);
						if (extTermWindowsVerbatimArguments) {
							effectiveCommand = (termPath + " " + extTermExecArgs.join(" ")).replace("[[[ScriptFile]]]", tempScript.fsPath);
							effectiveArgs = [];
						}
						console.log('ShellRunnerNotebooks: run command', effectiveCommand, effectiveArgs);
						console.log('ShellRunnerNotebooks: env', process.env);
						// There exists no way to make libuv CreateProcess with CREATE_NEW_CONSOLE:
						// https://github.com/libuv/libuv/blob/v1.48.0/src/win/process.c#L1041
						// Which is what we want here when launching a console applicaation.
						// (In a new console that does not inherit from the (hidden) console
						// of extension host; better detached, that is, does not exit if parent
						// exits)
						//
						// So we have to use detached: true, and necessarily use conhost.exe to
						// launch a console process.
						child_process.spawn(effectiveCommand, effectiveArgs, {
							cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
							env: (env => {
								for (const k of Object.keys(env)) {
									if (env[k] === '' || env[k] === null) {
										env[k] = undefined;
									}
								}
								return env;
							})({
								...process.env,
								// eslint-disable-next-line @typescript-eslint/naming-convention
								// 'HOME': undefined,
								...(patchedConfig.extTermEnvOverride ?? {}),
								...(cellExtTermOpts.extTermEnvOverride ?? {})
							}),
							shell: extTermSpawnShell,
							detached: true,
							windowsVerbatimArguments: extTermWindowsVerbatimArguments,
							
						}).on('exit', (code, signal) => {
							console.log('ShellRunnerNotebooks: process exited, code', code, 'signal', signal);
						}).on('spawn', () => {
							console.log('ShellRunnerNotebooks: process spawned');
						}).on('error', (err) => {
							console.error('ShellRunnerNotebooks: process err', err);
						});
						// child_process.execFile(effectiveCommand, effectiveArgs, {
						// 	encoding: 'utf-8',
						// 	cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
						// 	env: {
						// 		...process.env,
						// 		// eslint-disable-next-line @typescript-eslint/naming-convention
						// 		// 'HOME': undefined,
						// 	},
						// 	shell: extTermSpawnShell,
						// 	windowsVerbatimArguments: extTermWindowsVerbatimArguments,
						// });
					} else {
						vscode.window.showErrorMessage('No ext terminal path set.');
					}
				} catch (e) {
					console.error(e);
				}
			} else {
				vscode.window.activeTerminal!.sendText(filteredCellContentLines.join('\n'));
			}

			execution.end(undefined);
		}
	};
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.workspace.registerNotebookSerializer(
		PowerShellNotebookSerializer.type,
		new PowerShellNotebookSerializer(),
		{ transientOutputs: true }));


	const nbTypeToLangIdMap: any = {};
	const nbTypeToDefaultExtTermRunConfParamMap: any = {};

	const registerNotebookSerializerAndMemoTypeInfo = (notebookType: string, serializer: vscode.NotebookSerializer, options?: vscode.NotebookDocumentContentOptions | undefined): vscode.Disposable => {
		if (serializer instanceof ShNotebookSerializer) {
			nbTypeToLangIdMap[notebookType] = serializer.cellLanguage;
			nbTypeToDefaultExtTermRunConfParamMap[notebookType] = serializer.cellDefaultExtTermRunConfParam;
		}
		return vscode.workspace.registerNotebookSerializer(notebookType, serializer, options);
	};

	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"shnb",
		new ShNotebookSerializer("shellscript", "default"),
		{ transientOutputs: true }));
	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"sh-batnb",
		new ShNotebookSerializer("bat", "bat"),
		{ transientOutputs: true }));
	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"sh-pwshnb",
		new ShNotebookSerializer("powershell", "powershell"),
		{ transientOutputs: true }));
	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"sh-pynb",
		new ShNotebookSerializer("python", "runany:python"),
		{ transientOutputs: true }));
	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"sh-jsnb",
		new ShNotebookSerializer("javascript", "runany:node"),
		{ transientOutputs: true }));
	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"sh-tsnb",
		new ShNotebookSerializer("typescript", "runany:tsnode"),
		{ transientOutputs: true }));
	context.subscriptions.push(registerNotebookSerializerAndMemoTypeInfo(
		"sh-gennb",
		new ShNotebookSerializer("plaintext", "default"),
		{ transientOutputs: true }));
	
	context.subscriptions.push(vscode.workspace.registerNotebookSerializer(
		NotebookSerializer.type,
		new NotebookSerializer(),
		{ transientOutputs: true }));

	// "execute" a PowerShell cell
	const pwshController = vscode.notebooks.createNotebookController('powershellfile-kernel', 'pwshnb', 'PowerShell');
	pwshController.supportedLanguages = ['powershell'];
	pwshController.executeHandler = getExecuteHandler(pwshController, 'powershell');
	context.subscriptions.push(pwshController);

	// "execute" a shell cell
	const supportedLanguages = ['shellscript', 'python', 'javascript', 'bat', 'powershell', 'php', 'sql', 'swift', 'typescript', 'plaintext', 'ini', 'yaml', 'json', 'xml'];
	const supportedLanguagesWithThisAsFirst = (thisAsFirst: string | undefined) => {
		if (!thisAsFirst) {
			return supportedLanguages;
		}
		const mutated = [...supportedLanguages];
		mutated.sort((a, b) => {
			if (a === thisAsFirst) {
				return -1;
			}
			if (b === thisAsFirst) {
				return 1;
			}
			return 0;
		});
		return mutated;
	};
	for (const notebookType of ['shnb', 'sh-batnb', 'sh-pwshnb', 'sh-pynb', 'sh-jsnb', 'sh-tsnb', 'sh-gennb']) {
		const shController = vscode.notebooks.createNotebookController('shellfile-kernel-' + notebookType, notebookType, `ShellRunner (${notebookType})`);
		shController.supportedLanguages = supportedLanguagesWithThisAsFirst(nbTypeToLangIdMap[notebookType]);
		shController.executeHandler = getExecuteHandler(shController, nbTypeToDefaultExtTermRunConfParamMap[notebookType]);
		context.subscriptions.push(shController);
	}

	// "execute" a cell
	const nbController = vscode.notebooks.createNotebookController('shell-notebook-kernel', 'shell-notebook', 'Shell Notebook');
	// nbController.supportedLanguages = supportedLanguagesWithPlainTextAsFirst;
	nbController.supportedLanguages = supportedLanguages;
	nbController.executeHandler = getExecuteHandler(nbController, 'default');
	context.subscriptions.push(nbController);
}

// this method is called when your extension is deactivated
export function deactivate() {}
