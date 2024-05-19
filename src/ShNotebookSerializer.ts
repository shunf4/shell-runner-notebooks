import * as mergician from "mergician";
import * as vscode from "vscode";
import { NotebookCellData, NotebookCellKind, NotebookData, NotebookSerializer } from "vscode";

const EXT_TERM_DIRECTIVE_LONG_REGEX = new RegExp(/\[\[\[ShNb:(Et:?.*)\]\]\]/i);
export const COMMON_MERGICIAN = mergician.mergician({
    prependArrays: false,
    appendArrays: false,
    sortArrays: false,
    dedupArrays: false,
});

// https://stackoverflow.com/questions/5582248/split-a-string-only-the-at-the-first-n-occurrences-of-a-delimiter/50676897#50676897
// modified
function splitNGolangLike(str: string, delim: string, count: number) {
    const arr = str.split(delim);
    return [...arr.splice(0, count - 1), ...(((arr) => {
        return arr.length === 0 ? [] : [arr.join(delim)];
    })(arr))];
};

export class ShNotebookSerializer implements NotebookSerializer {
    static type: string = 'shnb';

    public cellLanguage: string;
    public cellDefaultExtTermRunConfParam: string;

    static parseExtTermDirective(lTrimStart: string, prerequisite: boolean, patchedConfig: any, defaultRunConfParam: string): {
        isDirectiveNotebookGlobal: boolean | undefined,
        isLineExtTermDirective: boolean | undefined,
        isUsingDefault: boolean | undefined,
        cellExtTermOpts: any | undefined,
        runConfVariantIdent: string | undefined,
    } {
        let isLineExtTermDirective: boolean | undefined = undefined;
        let isDirectiveNotebookGlobal: boolean | undefined = undefined;
        let isUsingDefault: boolean | undefined = undefined;
        let cellExtTermOpts: any | undefined = undefined;
        let runConfVariantIdent: string | undefined = undefined;
        let directiveBody: string[] | undefined = undefined;

        if (directiveBody === undefined) {
            const tryMatch = lTrimStart.match(EXT_TERM_DIRECTIVE_LONG_REGEX);
            if (tryMatch) {
                directiveBody = splitNGolangLike(tryMatch[1], ':', 2);
                if (directiveBody[0].toLowerCase() !== 'et') {
                    directiveBody = undefined;
                }
            }
        }
        if (directiveBody === undefined) {
            if (lTrimStart.startsWith('#')) {
                const lTrimHash = lTrimStart.substring(1).trim();
                directiveBody = splitNGolangLike(lTrimHash, ':', 2);
                if (directiveBody[0].toLowerCase() !== 'et') {
                    directiveBody = undefined;
                }
            }
        }

        if (prerequisite && directiveBody !== undefined) {
            isLineExtTermDirective = true;
            if (cellExtTermOpts === undefined) {
                cellExtTermOpts = {};
            }

            let runConfParam: string | undefined = undefined;
            isDirectiveNotebookGlobal = false;
            if (directiveBody.length === 2) {
                if (directiveBody[1].startsWith('notebookGlobal:')) {
                    directiveBody[1] = directiveBody[1].substring('notebookGlobal:'.length);
                    isDirectiveNotebookGlobal = true;
                    runConfParam = directiveBody[1];
                } else if (directiveBody[1] === 'notebookGlobal') {
                    runConfParam = undefined;
                    isDirectiveNotebookGlobal = true;
                } else {
                    runConfParam = directiveBody[1];
                }
            } else if (directiveBody.length === 1) {
                runConfParam = undefined;
            }

            isUsingDefault = runConfParam === undefined;
            if (runConfParam === undefined) {
                runConfParam = defaultRunConfParam;
            }

            if (runConfParam) {
                let directiveJson;
                try {
                    directiveJson = JSON.parse(runConfParam);
                } catch (e) {
                    directiveJson = (patchedConfig ?? {} as any)[runConfParam];
                    const extraParamSplitAgain = splitNGolangLike(runConfParam, ':', 2);
                    if (!directiveJson && extraParamSplitAgain.length >= 2) {
                        directiveJson = (patchedConfig ?? {} as any)[extraParamSplitAgain[0]];
                        runConfVariantIdent = extraParamSplitAgain[1];
                    }
                    if (typeof directiveJson === 'string') {
                        directiveJson = (patchedConfig ?? {} as any)[directiveJson];
                    }
                }
                
                if (!directiveJson || typeof directiveJson !== 'object') {
                    directiveJson = {};
                }
                cellExtTermOpts = {...cellExtTermOpts, ...directiveJson};
            }

            if (runConfVariantIdent) {
                const tryGetRunConfVariant = (cellExtTermOpts?.runConfVariant??{})[runConfVariantIdent];
                if (typeof tryGetRunConfVariant === 'string') {
                    runConfVariantIdent = tryGetRunConfVariant;
                } else if (typeof tryGetRunConfVariant === 'object') {
                } else {
                    runConfVariantIdent = undefined;
                }
            }

            if (runConfVariantIdent) {
                cellExtTermOpts = {
                    ...cellExtTermOpts,
                    ...((cellExtTermOpts?.runConfVariant??{})[runConfVariantIdent] ?? {})
                };
            }
        }

        return {
            cellExtTermOpts,
            isLineExtTermDirective,
            isDirectiveNotebookGlobal,
            runConfVariantIdent,
            isUsingDefault,
        };
    }

    constructor(cellLanguage: string, cellDefaultExtTermRunConfParam: string) {
        this.cellLanguage = cellLanguage;
        this.cellDefaultExtTermRunConfParam = cellDefaultExtTermRunConfParam;
    }

    createCell(cellKind: NotebookCellKind, source: string[], overrideCellLanguage: string | undefined, extraMetadata: any): NotebookCellData {
        const n = new NotebookCellData(
            cellKind,
            source.join('\n'),
            cellKind === NotebookCellKind.Markup ? "markdown" : (overrideCellLanguage ?? this.cellLanguage));
    
        if (!n.metadata) {
            n.metadata = {};
        }
        if (extraMetadata && typeof extraMetadata === 'object') {
            n.metadata = {...n.metadata, ...extraMetadata};
        }
        return n;
    }

    deserializeNotebook(data: Uint8Array): NotebookData {
        const config = vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfig");
		const configPatch = vscode.workspace.getConfiguration("shell-runner-notebooks").get<object>("extTermConfigPatch");
		const patchedConfig = COMMON_MERGICIAN(config, configPatch);
        
        const cells: NotebookCellData[] = [];
        const str = Buffer.from(data).toString();

        let lines: string[];
        // store the line ending in the metadata of the document
        // so that we honor the line ending of the original file
        // on save.
        let lineEnding: string;
        if (str.indexOf('\r\n') !== -1) {
            lines = str.split(/\r\n/g);
            lineEnding = '\r\n';
        } else {
            lines = str.split(/\n/g);
            lineEnding = '\n';
        }

        // not implemented
        // let notebookGlobalExtTermMetadata = {};

        let currentCellSource: string[] = [];
        let currentCellMetadata: any = {};
        let currentCellLanguageIdOverride: string | undefined = undefined;
        let cellKind: NotebookCellKind | undefined;

        let lastLineIsBlank: boolean | undefined = undefined;
        let lastButOneLineIsBlank: boolean | undefined = undefined;

        const endIfNeededAndStartCell = (kind: NotebookCellKind) => {
            // If cellKind has a value, then we can add the cell we've just computed.
            if (cellKind) {
                if (currentCellSource.length > 0 && currentCellSource[currentCellSource.length - 1].trim() === '') {
                    currentCellSource.pop();
                }
                if (currentCellSource.length > 0 && currentCellSource[currentCellSource.length - 1].trim() === '') {
                    currentCellSource.pop();
                }
                cells.push(this.createCell(
                    cellKind,
                    currentCellSource,
                    currentCellLanguageIdOverride,
                    currentCellMetadata,
                ));
            }

            // set initial new cell state
            currentCellSource = [];
            currentCellMetadata = {};
            currentCellLanguageIdOverride = undefined;
            cellKind = kind;
        };

        const removePrefixForMarkdown = (line: string) => {
            const indexOfHash = line.indexOf("#");
            line = line.substring(indexOfHash + 1);
            if (line.length > 0 && indexOfHash !== -1 && line[0] === ' ') {
                line = line.substring(1);
            }
            return line;
        };


        // Iterate through all lines in a document (aka sh file) and group the lines
        // into cells (markdown or code) that will be rendered in Notebook mode.
        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineTrim = line.trimStart();
            const currLineIsBlank = lineTrim === '';

            const { cellExtTermOpts, isLineExtTermDirective } = ShNotebookSerializer.parseExtTermDirective(
                lineTrim,
                !currLineIsBlank
                    && (
                        (currentCellSource.length === 0
                            || currentCellSource.every(x => x.trim() === '')
                        ) 
                        || (
                            (lastLineIsBlank ?? true)
                            && (lastButOneLineIsBlank ?? true)
                        )
                    ),
                patchedConfig,
                this.cellDefaultExtTermRunConfParam,
            );

            let lineIsMarkdownDirective;
            if (currLineIsBlank) {
                lineIsMarkdownDirective = false;
            } else {
                if (line.toLowerCase().indexOf("[[[shnb:md]]]") > -1
                    || (lineTrim.startsWith('#') && lineTrim.substring(1).trimLeft().split(':', 2)[0].toLowerCase() === 'md')) {
                    if (currentCellSource.length === 0
                        || currentCellSource.every(x => x.trim() === '')
                        || (
                            (lastLineIsBlank ?? true)
                            && (lastButOneLineIsBlank ?? true)
                        )) {
                        lineIsMarkdownDirective = true;
                    } else {
                        lineIsMarkdownDirective = false;
                    }
                } else {
                    lineIsMarkdownDirective = false;
                }
            }

            let shouldStartNewBlock = false;
            if ((lastLineIsBlank ?? true) && (lastButOneLineIsBlank ?? true) && !currLineIsBlank) {
                shouldStartNewBlock = true;
            }

            let currKind = cellKind;

            if (shouldStartNewBlock) {
                let newKind = NotebookCellKind.Code;
                if (lineIsMarkdownDirective) {
                    newKind = NotebookCellKind.Markup;
                }
                endIfNeededAndStartCell(newKind);
                currKind = newKind;
                if (lineIsMarkdownDirective) {
                    currentCellMetadata.markupDirectiveOrigLine = line;
                }
                if (isLineExtTermDirective) {
                    currentCellLanguageIdOverride = ((cellExtTermOpts?.languageId) || undefined);
                }
            }
            
            if (currKind === NotebookCellKind.Markup) {
                if (!lineIsMarkdownDirective) {
                    currentCellSource.push(removePrefixForMarkdown(line));
                }
            } else {
                currentCellSource.push(line);
            }

            lastButOneLineIsBlank = lastLineIsBlank;
            lastLineIsBlank = (lineTrim === '');
        }

        // If we have some leftover lines that have not been added 
        // add the appropriate cell.
        if (currentCellSource.length && cellKind) {
            cells.push(this.createCell(
                cellKind,
                currentCellSource,
                currentCellLanguageIdOverride,
                currentCellMetadata,
            ));
        }

        const notebookData = new NotebookData(cells);
        notebookData.metadata = {
            custom: {
                lineEnding
            }
        };
        return notebookData;
    }

    serializeNotebook(data: NotebookData): Uint8Array {

        const addPrefixForMarkdownOneCellMapFuncGen = () => {
            let everMetNonBlankLine = false;
            return (line: string) => {
                const lineTrim = line.trimStart();
                const currLineIsBlank = lineTrim === '';
                const startsWithHash = lineTrim.startsWith("#");
        
                let lineIsMarkdownDirective;
                if (currLineIsBlank || !startsWithHash) {
                    lineIsMarkdownDirective = false;
                } else {
                    if (lineTrim.substring(1).trim().split(":", 2)[0] === "md") {
                        if (!everMetNonBlankLine) {
                            lineIsMarkdownDirective = true;
                        } else {
                            lineIsMarkdownDirective = false;
                        }
                    } else {
                        lineIsMarkdownDirective = false;
                    }
                }

                if (!currLineIsBlank) {
                    everMetNonBlankLine = true;
                }
        
                if (lineIsMarkdownDirective) {
                    return line;
                }
                return `# ${line}`;
            };
        };

        const retArr: string[] = [];
        let isFirstCell = true;
        for (const cell of data.cells) {
            if (!isFirstCell) {
                retArr.push('', '');
            }
            if (cell.kind === NotebookCellKind.Code) {
                retArr.push(...cell.value.split(/\r\n|\n/));
            } else {
                retArr.push((cell.metadata?.markupDirectiveOrigLine || '# md'), ...cell.value.split(/\r\n|\n/).map(addPrefixForMarkdownOneCellMapFuncGen()));
            }
            isFirstCell = false;
        }

        const eol: string = data.metadata?.custom.lineEnding;
        return Buffer.from(retArr.join(eol));
    }
}
