// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { PowerShellNotebookSerializer } from './PowerShellNotebookSerializer';
import { ShNotebookSerializer } from './ShNotebookSerializer';
import { NotebookSerializer } from './NotebookSerializer';
import * as child_process from 'child_process';
import * as fs from 'fs'
import { TextEncoder } from 'util';

function getExecuteHandler(controller: vscode.NotebookController) {
	return async (cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument) => {
		if (!vscode.window.activeTerminal) {
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
		}

		for (const cell of cells) {
			const execution = controller.createNotebookCellExecution(cell);
			execution.start();
			const cellContent = execution.cell.document.getText();

			let cellExtTermOpts: any = {};

			const cellLines = cellContent.split('\n');
			const cellExtTermContentLines = [];
			let nonSpaceMet = false;
			for (const l of cellLines) {
				const lTrimStart = l.trimStart();
				if (lTrimStart === '') {
					cellExtTermContentLines.push(l);
					continue;
				}
				let isLineExtTermDirective = false;
				if (lTrimStart.startsWith('#')) {
					const lTrimHash = lTrimStart.substring(1).trim();
					const lTrimHashSplit = lTrimHash.split(':::', 3);
					if (!nonSpaceMet && lTrimHashSplit[0] === 'et') {
						isLineExtTermDirective = true;
						cellExtTermOpts.isExtTerm = true;

                        let directiveJsonStr = "default";
                        let directiveOptIsNotebookGlobal = false;
                        if (lTrimHashSplit.length === 3) {
                            if (lTrimHashSplit[1] === 'notebookGlobal') {
                                directiveJsonStr = lTrimHashSplit[2];
                                directiveOptIsNotebookGlobal = true;
                            }
                        } else if (lTrimHashSplit.length === 2) {
                            directiveJsonStr = lTrimHashSplit[1];
                        } else if (lTrimHashSplit.length === 1) {
                            directiveJsonStr = "default";
                        }
                        if (directiveJsonStr) {
                            let directiveJson;
                            try {
                                directiveJson = JSON.parse(directiveJsonStr);
                            } catch (e) {
                                directiveJson = (vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfig") ?? {} as any)[directiveJsonStr];
								if (typeof directiveJson === 'string') {
									directiveJson = (vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfig") ?? {} as any)[directiveJson];
								}
                            }
                            if (directiveOptIsNotebookGlobal) {
                                // not implemented
                            } else {
								if (!directiveJson || typeof directiveJson !== 'object') {
									directiveJson = {};
								}
                                cellExtTermOpts = {...cellExtTermOpts, ...directiveJson};
                            }
                        }
					}
				}
				if (!isLineExtTermDirective) {
					cellExtTermContentLines.push(l);
				}
				nonSpaceMet = true;
			}

			if (cellExtTermOpts.isExtTerm) {
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

					if (termPath) {
						const tempScript = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, "___externalTerminalTempScript." + extTermTempScriptExtension);

						await vscode.workspace.fs.writeFile(tempScript, Buffer.from(cellExtTermContentLines.join('\n'), extTermTempScriptEncoding as BufferEncoding));

						let effectiveCommand = termPath;
						let effectiveArgs = [...extTermExecArgs, tempScript.fsPath];
						if (extTermWindowsVerbatimArguments) {
							effectiveCommand = (termPath + " " + extTermExecArgs.join(" ")).replace("[[[ScriptFile]]]", tempScript.fsPath);
							effectiveArgs = [];
						}
						console.log(effectiveCommand, effectiveArgs);
						child_process.spawn(effectiveCommand, effectiveArgs, {
							cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
							shell: extTermSpawnShell,
							detached: true,
							windowsVerbatimArguments: extTermWindowsVerbatimArguments,
							
						});
					} else {
						vscode.window.showErrorMessage('No ext terminal path set.');
					}
				} catch (e) {
					console.error(e);
				}
			} else {
				vscode.window.activeTerminal!.sendText(cellContent);
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

	context.subscriptions.push(vscode.workspace.registerNotebookSerializer(
		ShNotebookSerializer.type,
		new ShNotebookSerializer(),
		{ transientOutputs: true }));
	
	context.subscriptions.push(vscode.workspace.registerNotebookSerializer(
		NotebookSerializer.type,
		new NotebookSerializer(),
		{ transientOutputs: true }));

	// "execute" a PowerShell cell
	const pwshController = vscode.notebooks.createNotebookController('powershellfile-kernel', 'pwshnb', 'PowerShell');
	pwshController.supportedLanguages = ['powershell'];
	pwshController.executeHandler = getExecuteHandler(pwshController);
	context.subscriptions.push(pwshController);

	// "execute" a shell cell
	const shController = vscode.notebooks.createNotebookController('shellfile-kernel', 'shnb', 'Shell');
	shController.supportedLanguages = ['shellscript'];
	shController.executeHandler = getExecuteHandler(shController);
	context.subscriptions.push(shController);

	// "execute" a cell
	const nbController = vscode.notebooks.createNotebookController('shell-notebook-kernel', 'shell-notebook', 'Shell Notebook');
	nbController.supportedLanguages = ['powershell', 'shellscript'];
	nbController.executeHandler = getExecuteHandler(nbController);
	context.subscriptions.push(nbController);
}

// this method is called when your extension is deactivated
export function deactivate() {}
