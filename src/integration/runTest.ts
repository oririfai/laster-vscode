import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/** Runs the integration suite in a separate VSCode instance against a temporary git workspace. */
async function main(): Promise<void> {
  // When run from a terminal inside VSCode, this variable would make the test VSCode run as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'laster-ws-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'util.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'gone.ts'), 'delete me\n');
  fs.writeFileSync(path.join(workspace, 'src', 'user.ts'), 'let u = 1;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'branchy.ts'), 'main version\n');
  const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('');
  fs.writeFileSync(path.join(workspace, 'src', 'multi.ts'), ten);
  fs.writeFileSync(path.join(workspace, 'src', 'manual.ts'), ten);
  fs.writeFileSync(path.join(workspace, 'src', 'race.ts'), ten);
  for (const name of ['inedit', 'typing', 'undo', 'inline', 'pasted', 'cline', 'discard']) {
    fs.writeFileSync(path.join(workspace, 'src', `${name}.ts`), ten);
  }

  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(workspace, 'src', 'branchy.ts'), 'feature version\n');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'feature');
  git('checkout', '-q', 'main');

  await runTests({
    // LASTER_EXTENSION_PATH lets CI run the suite against an unpacked .vsix instead of the dev folder.
    extensionDevelopmentPath: process.env.LASTER_EXTENSION_PATH ?? path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, 'suite'),
    extensionTestsEnv: { LASTER_TEST_WORKSPACE: workspace },
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'laster-ud-'))}`],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
