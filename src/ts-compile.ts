import {
  sys,
  findConfigFile,
  createProgram,
  flattenDiagnosticMessageText,
  formatDiagnostic,
  createWatchCompilerHost,
  createEmitAndSemanticDiagnosticsBuilderProgram,
  createWatchProgram,
  readConfigFile,
  getPreEmitDiagnostics,
  parseJsonConfigFileContent,
  createBuilderStatusReporter,
} from "typescript";

const configPath = findConfigFile(
  process.cwd(),
  sys.fileExists,
  "tsconfig.json"
);

const parseConfigHost /* : any */ = {
  fileExists: sys.fileExists,
  readDirectory: sys.readDirectory,
  readFile: sys.readFile,
  useCaseSensitiveFileNames: true,
};

export function compile(fileNames: string[]) {
  // const options = <CompilerOptions>parseJsonConfigFileContent(configPath, parseConfigHost, "./");
  if (!configPath) throw 'Could not find "tsconfig.json"';
  const configFile = readConfigFile(configPath, sys.readFile);
  const parsedConfig = parseJsonConfigFileContent(
    configFile.config,
    parseConfigHost,
    "./"
  );
  // rootDir: src ensures that we consistently make the plugin directories in dist/tmp/
  let program = createProgram(fileNames, {
    ...parsedConfig.options,
    rootDir: "src",
  });
  let emitResult = program.emit();

  let allDiagnostics = getPreEmitDiagnostics(program).concat(
    emitResult.diagnostics
  );

  allDiagnostics.forEach((diagnostic) => {
    if (diagnostic.file) {
      let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start!
      );
      let message = flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      console.log(
        `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`
      );
    } else {
      console.log(
        `${flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`
      );
    }
  });

  if (emitResult.emitSkipped) throw "TypeScript compile errors.";
}

const formatHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: sys.getCurrentDirectory,
  getNewLine: () => sys.newLine,
};

// TODO: this might have room for perf. improvement with incremental building
export function watch(fileNames: string[], cb?: () => void) {
  if (!configPath) {
    throw new Error('Could not find a valid "tsconfig.json".');
  }
  // TypeScript can use several different program creation "strategies":
  //  * ts.createEmitAndSemanticDiagnosticsBuilderProgram,
  //  * ts.createSemanticDiagnosticsBuilderProgram
  //  * ts.createAbstractBuilder
  // The first two produce "builder programs". These use an incremental strategy
  // to only re-check and emit files whose contents may have changed, or whose
  // dependencies may have changes which may impact change the result of prior
  // type-check and emit.
  // The last uses an ordinary program which does a full type check after every
  // change.
  // Between `createEmitAndSemanticDiagnosticsBuilderProgram` and
  // `createSemanticDiagnosticsBuilderProgram`, the only difference is emit.
  // For pure type-checking scenarios, or when another tool/process handles emit,
  // using `createSemanticDiagnosticsBuilderProgram` may be more desirable.
  const createProgram = createEmitAndSemanticDiagnosticsBuilderProgram;

  // Note that there is another overload for `createWatchCompilerHost` that takes
  // a set of root files.
  const host = createWatchCompilerHost(
    configPath,
    {},
    sys,
    createProgram,
    reportDiagnostic,
    reportWatchStatusChanged
  );

  // You can technically override any given hook on the host, though you probably
  // don't need to.
  // Note that we're assuming `origCreateProgram` and `origPostProgramCreate`
  // doesn't use `this` at all.
  const origCreateProgram = host.createProgram;
  host.createProgram = (rootNames, options, host, oldProgram) => {
    return origCreateProgram(
      fileNames,
      { ...options, rootDir: "src" },
      host,
      oldProgram
    );
  };
  const origPostProgramCreate = host.afterProgramCreate;

  host.afterProgramCreate = (program) => {
    origPostProgramCreate!(program);
    console.log("Done compiling changed typescript.");
    if (cb) cb();
  };

  // `createWatchProgram` creates an initial program, watches files, and updates
  // the program over time.
  createWatchProgram(host);
}

function reportDiagnostic(diagnostic) {
  console.error(
    "Error",
    diagnostic.code,
    ":",
    flattenDiagnosticMessageText(
      diagnostic.messageText,
      formatHost.getNewLine()
    )
  );
}

/**
 * Prints a diagnostic every time the watch status changes.
 * This is mainly for messages like "Starting compilation" or "Compilation completed".
 */
function reportWatchStatusChanged(diagnostic) {
  console.info(formatDiagnostic(diagnostic, formatHost));
}
