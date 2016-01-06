import * as fs from 'fs';
import * as glob from 'glob';
import * as mkdirp from 'mkdirp';
import * as os from 'os';
import * as pathUtil from 'path';
import * as Promise from 'bluebird';
import * as ts from 'typescript';

/* This node type appears to not be available in 1.6-beta, so "recreating" */
interface StringLiteralTypeNode extends ts.TypeNode {
	text: string;
}

interface Options {
	baseDir?: string;
	project?: string;
	files?: string[];
	exclude?: string[];
	externs?: string[];
	eol?: string;
	includes?: string[];
	indent?: string;
	main?: string;
	moduleResolution?: ts.ModuleResolutionKind;
	name: string;
	out: string;
	outDir?: string;
	target?: ts.ScriptTarget;
	sendMessage?: (message: any, ...optionalParams: any[]) => void;
	verbose?: boolean;
}

const filenameToMid: (filename: string) => string = (function () {
	if (pathUtil.sep === '/') {
		return function (filename: string) {
			return filename;
		};
	}
	else {
		const separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
		return function (filename: string) {
			return filename.replace(separatorExpression, '/');
		};
	}
})();

function getError(diagnostics: ts.Diagnostic[]) {
	let message = 'Declaration generation failed';

	diagnostics.forEach(function (diagnostic) {
		const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

		message +=
			`\n${diagnostic.file.fileName}(${position.line + 1},${position.character + 1}): ` +
			`error TS${diagnostic.code}: ${diagnostic.messageText}`;
	});

	const error = new Error(message);
	error.name = 'EmitterError';
	return error;
}

function getFilenames(baseDir: string, files: string[]): string[] {
	return files.map(function (filename) {
		const resolvedFilename = pathUtil.resolve(filename);
		if (resolvedFilename.indexOf(baseDir) === 0) {
			return resolvedFilename;
		}

		return pathUtil.resolve(baseDir, filename);
	});
}

function processTree(sourceFile: ts.SourceFile, replacer: (node: ts.Node) => string): string {
	let code = '';
	let cursorPosition = 0;

	function skip(node: ts.Node) {
		cursorPosition = node.end;
	}

	function readThrough(node: ts.Node) {
		code += sourceFile.text.slice(cursorPosition, node.pos);
		cursorPosition = node.pos;
	}

	function visit(node: ts.Node) {
		readThrough(node);

		const replacement = replacer(node);

		if (replacement != null) {
			code += replacement;
			skip(node);
		}
		else {
			ts.forEachChild(node, visit);
		}
	}

	visit(sourceFile);
	code += sourceFile.text.slice(cursorPosition);

	return code;
}

function getTSConfig(options: Options, fileName: string): Options {
	const configText = fs.readFileSync(fileName, { encoding: 'utf8' });
	const result = ts.parseConfigFileTextToJson(fileName, configText);
	const configObject = result.config;
	const configParseResult = ts.parseJsonConfigFileContent(configObject, ts.sys, pathUtil.dirname(fileName));
	options.target = configParseResult.options.target;
	if (configParseResult.options.outDir) {
		options.outDir = configParseResult.options.outDir;
	}
	if (configParseResult.options.moduleResolution) {
		options.moduleResolution = configParseResult.options.moduleResolution;
	}
	options.files = configParseResult.fileNames;
	return;
}

export default function generate(options: Options): Promise<void> {

	const noop = function (message?: any, ...optionalParams: any[]): void {};
	const sendMessage = options.sendMessage || noop;
	const verboseMessage = options.verbose ? sendMessage : noop;

	/* following tsc behaviour, if a project is speicified, or if no files are specified then
	 * attempt to load tsconfig.json */
	if (options.project || !options.files || options.files.length === 0) {
		verboseMessage(`project = "${options.project || options.baseDir}"`);
		const tsconfigFilename = pathUtil.join(options.project || options.baseDir, 'tsconfig.json');
		if (fs.existsSync(tsconfigFilename)) {
			verboseMessage(`  parsing "${tsconfigFilename}"`);
			getTSConfig(options, tsconfigFilename);
		}
		else {
			sendMessage(`No "tsconfig.json" found at "${tsconfigFilename}"!`);
			return new Promise<void>(function (resolve, reject) {
				reject(new SyntaxError('Unable to resolve configuration.'));
			});
		}
	}

	const baseDir = pathUtil.resolve(options.project || options.baseDir);
	verboseMessage(`baseDir = "${baseDir}"`);
	const eol = options.eol || os.EOL;
	const nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
	const indent = options.indent === undefined ? '\t' : options.indent;
	const target = options.target || ts.ScriptTarget.Latest;
	verboseMessage(`taget = ${target}`);
	const compilerOptions: ts.CompilerOptions = {
		declaration: true,
		module: ts.ModuleKind.CommonJS,
		target: target
	};
	if (options.outDir) {
		verboseMessage(`outDir = ${options.outDir}`);
		compilerOptions.outDir = options.outDir;
	}
	if (options.moduleResolution) {
		verboseMessage(`moduleResolution = ${options.moduleResolution}`);
		compilerOptions.moduleResolution = options.moduleResolution;
	}

	const filenames = getFilenames(baseDir, options.files);
	verboseMessage('filenames:');
	filenames.forEach(name => { verboseMessage('  ' + name); });
	const excludesMap: { [filename: string]: boolean; } = {};

	options.exclude = options.exclude || [ 'node_modules/**/*.d.ts' ];

	options.exclude && options.exclude.forEach(function (filename) {
		glob.sync(filename).forEach(function(globFileName) {
			excludesMap[filenameToMid(pathUtil.resolve(baseDir, globFileName))] = true;
		});
	});
	if (options.exclude) {
		verboseMessage('exclude:');
		options.exclude.forEach(name => { verboseMessage('  ' + name); });
	}

	mkdirp.sync(pathUtil.dirname(options.out));
	/* node.js typings are missing the optional mode in createWriteStream options and therefore
	 * in TS 1.6 the strict object literal checking is throwing, therefore a hammer to the nut */
	const output = fs.createWriteStream(options.out, <any> { mode: parseInt('644', 8) });

	const host = ts.createCompilerHost(compilerOptions);
	const program = ts.createProgram(filenames, compilerOptions, host);

	function writeFile(filename: string, data: string, writeByteOrderMark: boolean) {
		// Compiler is emitting the non-declaration file, which we do not care about
		if (filename.slice(-5) !== '.d.ts') {
			return;
		}

		writeDeclaration(ts.createSourceFile(filename, data, target, true));
	}

	return new Promise<void>(function (resolve, reject) {
		output.on('close', () => { resolve(undefined); });
		output.on('error', reject);

		if (options.externs) {
			options.externs.forEach(function (path: string) {
				sendMessage(`Writing external dependency ${path}`);
				output.write(`/// <reference path="${path}" />` + eol);
			});
		}

		sendMessage('processing:');
		program.getSourceFiles().some(function (sourceFile) {
			// Source file is a default library, or other dependency from another project, that should not be included in
			// our bundled output
			if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
				return;
			}

			if (excludesMap[filenameToMid(pathUtil.normalize(sourceFile.fileName))]) {
				return;
			}

			sendMessage(`  ${sourceFile.fileName}`);

			// Source file is already a declaration file so should does not need to be pre-processed by the emitter
			if (sourceFile.fileName.slice(-5) === '.d.ts') {
				writeDeclaration(sourceFile);
				return;
			}

			const emitOutput = program.emit(sourceFile, writeFile);
			if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
				reject(getError(
					emitOutput.diagnostics
						.concat(program.getSemanticDiagnostics(sourceFile))
						.concat(program.getSyntacticDiagnostics(sourceFile))
						.concat(program.getDeclarationDiagnostics(sourceFile))
				));

				return true;
			}
		});

		if (options.main) {
			output.write(`declare module '${options.name}' {` + eol + indent);
			output.write(`import main = require('${options.main}');` + eol + indent);
			output.write('export = main;' + eol);
			output.write('}' + eol);
			sendMessage(`Aliased main module ${options.name} to ${options.main}`);
		}

		sendMessage(`output to "${options.out}"`);
		output.end();
	});

	function writeDeclaration(declarationFile: ts.SourceFile) {
		const filename = declarationFile.fileName;
		const sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));

		/* For some reason, SourceFile.externalModuleIndicator is missing from 1.6-beta, so having
		 * to use a sledgehammer on the nut */
		if ((<any> declarationFile).externalModuleIndicator) {
			output.write('declare module \'' + sourceModuleId + '\' {' + eol + indent);

			const content = processTree(declarationFile, function (node) {
				if (node.kind === ts.SyntaxKind.ExternalModuleReference) {
					const expression = <ts.LiteralExpression> (<ts.ExternalModuleReference> node).expression;

					if (expression.text.charAt(0) === '.') {
						return ' require(\'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + '\')';
					}
				}
				else if (node.kind === ts.SyntaxKind.DeclareKeyword) {
					return '';
				}
				else if (node.kind === ts.SyntaxKind.ImportDeclaration){
                    			if (node["moduleSpecifier"] && node["importClause"]) {
                        			if (node["importClause"]["name]) {
                            				return ' import ' + node["importClause"]["name"]["text"] + ' from \'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), node["moduleSpecifier"]["text"])) + '\';'
                        			}
                        			else if (node["importClause"]["namedBindings"]) {
                            				var bindingElements = node["importClause"]["namedBindings"]["elements"];
                            				var names = []
				                        for (var i in bindingElements) {
				                        	if (typeof (bindingElements[i]) === "object") {
				                                    names.push(bindingElements[i].name.text);
				                                }
				
				                        }
				
				                        return ' import {' + names.join(", ") + '} from \'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), node["moduleSpecifier"]["text"])) + '\';'
				
				                }
                    			}
                		}
				else if (
					node.kind === ts.SyntaxKind.StringLiteral &&
					(node.parent.kind === ts.SyntaxKind.ExportDeclaration || node.parent.kind === ts.SyntaxKind.ImportDeclaration)
				) {
					const text = (<StringLiteralTypeNode> node).text;
					if (text.charAt(0) === '.') {
						return ` '${filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text))}'`;
					}
				}
			});

			output.write(content.replace(nonEmptyLineStart, '$&' + indent));
			output.write(eol + '}' + eol);
		}
		else {
			output.write(declarationFile.text);
		}
	}
}
