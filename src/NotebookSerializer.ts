import { TextDecoder, TextEncoder } from 'util';
import * as vscode from 'vscode';
import { COMMON_MERGICIAN, ShNotebookSerializer } from './ShNotebookSerializer';
import * as os from 'os';
import * as fs from 'fs';

interface RawNotebookCell {
	language: string;
	value: string;
	kind: vscode.NotebookCellKind;
    editable?: boolean;
}

export class NotebookSerializer implements vscode.NotebookSerializer {
    static type: string = 'shell-notebook';

	static async decideLanguage(value: string, patchedConfig: any): Promise<string | undefined> {
		for (const line of value.split('\n')) {
			const lTrimStart = line.trimStart();
			if (lTrimStart === '') {
				continue;
			}

			const { cellExtTermOpts, isLineExtTermDirective } = ShNotebookSerializer.parseExtTermDirective(
				lTrimStart,
				true,
				patchedConfig,
				"default",
			);
			
			if (isLineExtTermDirective) {
				return ((cellExtTermOpts?.languageId) || undefined);
			}
			break;
		}
		return undefined;
	}

    async deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): Promise<vscode.NotebookData> {
        var contents = new TextDecoder().decode(content);    // convert to String to make JSON object

        // Read file contents
		let raw: RawNotebookCell[];
		try {
			raw = <RawNotebookCell[]>JSON.parse(contents);
		} catch {
			raw = [];
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

        // Create array of Notebook cells for the VS Code API from file contents
		const cells = await raw.reduce(async (memo, item) => {
			return [...(await memo), new vscode.NotebookCellData(
				item.kind,
				item.value,
				// (await NotebookSerializer.decideLanguage(item.value, patchedConfig)) ?? item.language)];
				item.language)];
		}, Promise.resolve([] as vscode.NotebookCellData[]));

        // Pass read and formatted Notebook Data to VS Code to display Notebook with saved cells
		return new vscode.NotebookData(
			cells
		);
    }

    async serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Promise<Uint8Array> {
        // Map the Notebook data into the format we want to save the Notebook data as

		let contents: RawNotebookCell[] = [];

		for (const cell of data.cells) {
			contents.push({
				kind: cell.kind,
				language: cell.languageId,
				value: cell.value
			});
		}

        // Give a string of all the data to save and VS Code will handle the rest 
		return new TextEncoder().encode(JSON.stringify(contents));
    }    
}
