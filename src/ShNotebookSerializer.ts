import { NotebookCellData, NotebookCellKind, NotebookData, NotebookSerializer } from "vscode";

function createCell(cellKind: NotebookCellKind, source: string[]): NotebookCellData {
	const n = new NotebookCellData(
		cellKind,
		source.join('\n'),
		cellKind === NotebookCellKind.Markup ? "markdown" : "shellscript");

    if (!n.metadata) {
        n.metadata = {};
    }
    return n;
}

export class ShNotebookSerializer implements NotebookSerializer {
    static type: string = 'shnb';

    deserializeNotebook(data: Uint8Array): NotebookData {
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
        let cellKind: NotebookCellKind | undefined;
        let insideBlockComment: boolean = false;

        let lastCodeLineIsEmpty = false;
        let lastButOneCodeLineIsEmpty = false;

        const endIfNeededAndStartBlock = (kind: NotebookCellKind) => {
            // If cellKind has a value, then we can add the cell we've just computed.
            if (cellKind) {
                if (cellKind === NotebookCellKind.Code) {
                    if (currentCellSource.length > 0 && currentCellSource[currentCellSource.length - 1].trim() === '') {
                        currentCellSource.pop();
                    }
                    if (currentCellSource.length > 0 && currentCellSource[currentCellSource.length - 1].trim() === '') {
                        currentCellSource.pop();
                    }
                }
                cells.push(createCell(
                    cellKind,
                    currentCellSource,
                ));
            }

            lastCodeLineIsEmpty = false;
            lastButOneCodeLineIsEmpty = false;

            // set initial new cell state
            currentCellSource = [];
            cellKind = kind;
        }

        const removePrefixForMarkdown = (line: string) => {
            line = line.substring(line.indexOf("#") + 1);
            if (line.length > 0 && line[0] === ' ') {
                line = line.substring(1);
            }
            return line;
        }


        // This dictates whether the BlockComment cell was read in with content on the same
        // line as the opening <#. This is so we can preserve the format of the backing file on save.
        let openBlockCommentOnOwnLine: boolean = false;

        // Iterate through all lines in a document (aka ps1 file) and group the lines
        // into cells (markdown or code) that will be rendered in Notebook mode.
        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < lines.length; i++) {
            // Handle everything else (regular comments and code)
            // If a line starts with # it's a comment

            const lineTrim = lines[i].trimStart();
            const startsWithHash = lineTrim.startsWith("#");

            const lineIsExtTermDirective = !startsWithHash ? false : (lineTrim.substring(1).trim().split(":::", 2)[0] === "et" && (currentCellSource.length === 0 || currentCellSource.every(x => x.trim() === '' || lastCodeLineIsEmpty && lastButOneCodeLineIsEmpty)));

            const kind: NotebookCellKind = (startsWithHash && !lineIsExtTermDirective) ? NotebookCellKind.Markup : NotebookCellKind.Code;

            let shouldStartNewBlock = false;

            // If this line is a continuation of the previous cell type, then add this line to the current cell source.
            if (kind === cellKind) {
                if (kind === NotebookCellKind.Code && lastCodeLineIsEmpty && lastButOneCodeLineIsEmpty) {
                    if (currentCellSource.length > 0) {
                        currentCellSource.pop();
                    }
                    if (currentCellSource.length > 0) {
                        currentCellSource.pop();
                    }
                    
                    shouldStartNewBlock = true;
                } else {
                    shouldStartNewBlock = false;
                }
            } else {
                shouldStartNewBlock = true;
            }

            let lastIsCodeAndCurrIsMarkup = false;

            if (shouldStartNewBlock) {
                if (kind === NotebookCellKind.Code && cellKind === NotebookCellKind.Markup) {
                    lastIsCodeAndCurrIsMarkup = true;
                }
                endIfNeededAndStartBlock(kind);
            }

            

            if (lastIsCodeAndCurrIsMarkup && lineTrim === '') {
                // treat as the separator between a markdown and a code
            } else {
                currentCellSource.push(kind === NotebookCellKind.Markup && !insideBlockComment ? removePrefixForMarkdown(lines[i]) : lines[i]);

                if (kind == NotebookCellKind.Code) {
                    lastButOneCodeLineIsEmpty = lastCodeLineIsEmpty;
                    lastCodeLineIsEmpty = (lineTrim === '');
                }
            }
        }

        // If we have some leftover lines that have not been added (for example,
        // when there is only the _start_ of a block comment but not an _end_.)
        // add the appropriate cell.
        if (currentCellSource.length) {
            cells.push(createCell(
                cellKind!,
                currentCellSource,
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
        const retArr: string[] = [];
        let lastCellKind;
        for (const cell of data.cells) {
            switch (lastCellKind) {
                case NotebookCellKind.Code:
                    retArr.push('', '');
                    break;
                case NotebookCellKind.Markup:
                    retArr.push('');
                    break;
            }
            if (cell.kind === NotebookCellKind.Code) {
                retArr.push(...cell.value.split(/\r\n|\n/));
            } else {
                retArr.push(...cell.value.split(/\r\n|\n/).map((line) => `# ${line}`));
            }
            lastCellKind = cell.kind;
        }

        const eol: string = data.metadata?.custom.lineEnding;
        return Buffer.from(retArr.join(eol));
    }
}
