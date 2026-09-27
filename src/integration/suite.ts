import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LasterApi } from '../extension';

const ws = process.env.LASTER_TEST_WORKSPACE!;
const file = (rel: string) => path.join(ws, rel);
const uriOf = (rel: string) => vscode.Uri.file(file(rel));

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timeout: ${what}`);
}

/** `cond` stays true for `ms` (to make sure something does NOT happen). */
async function stays(what: string, cond: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert.ok(cond(), what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<LasterApi>('oririfai.laster')!;
  const api = await ext.activate();
  assert.ok(api, 'extension is active');
  await api.ready;
  const t = api.tracker;
  const pending = (rel: string) => t.getPending(uriOf(rel));

  const cases: [string, () => Promise<void>][] = [
    [
      'write from outside VSCode (CLI agent) → pending modified',
      async () => {
        fs.writeFileSync(file('src/app.ts'), 'const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n');
        await waitFor('app.ts pending', () => pending('src/app.ts')?.kind === 'modified');
        assert.deepEqual(pending('src/app.ts')!.stats, { added: 2, removed: 1 });
      },
    ],
    [
      'new file from outside → pending added',
      async () => {
        fs.writeFileSync(file('src/new.ts'), 'new\n');
        await waitFor('new.ts pending', () => pending('src/new.ts')?.kind === 'added');
      },
    ],
    [
      'delete from outside → pending deleted',
      async () => {
        fs.rmSync(file('src/gone.ts'));
        await waitFor('gone.ts pending', () => pending('src/gone.ts')?.kind === 'deleted');
      },
    ],
    [
      'user edit + save → not pending',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/user.ts'));
        await vscode.window.showTextDocument(doc);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(1, 0), 'let v = 2;\n');
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await stays('user.ts not pending', () => !pending('src/user.ts'));
      },
    ],
    [
      'Approve → not pending, and stays clean afterwards',
      async () => {
        await vscode.commands.executeCommand('laster.approveFile', uriOf('src/new.ts'));
        assert.equal(pending('src/new.ts'), undefined);
        assert.equal(await t.baselineText(uriOf('src/new.ts')), 'new\n');
      },
    ],
    [
      'Revert an open file → content back to baseline',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/app.ts'));
        await vscode.window.showTextDocument(doc);
        await waitFor('document shows the agent version', () => doc.getText().includes('const d = 4;'));
        await t.revert(doc.uri);
        await waitFor('app.ts not pending', () => !pending('src/app.ts'));
        assert.equal(fs.readFileSync(file('src/app.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      },
    ],
    [
      'Revert a deleted file → recreated',
      async () => {
        await t.revert(uriOf('src/gone.ts'));
        await waitFor('gone.ts not pending', () => !pending('src/gone.ts'));
        assert.equal(fs.readFileSync(file('src/gone.ts'), 'utf8'), 'delete me\n');
      },
    ],
    [
      'v0.2: user edits outside AI regions are not highlighted, inside they stay',
      async () => {
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
        // Agent: replace line 3 and delete line 8.
        const ai = [...lines];
        ai[2] = 'AI three';
        ai.splice(7, 1);
        fs.writeFileSync(file('src/multi.ts'), ai.join('\n') + '\n');
        await waitFor('multi.ts pending', () => pending('src/multi.ts')?.kind === 'modified');

        const doc = await vscode.workspace.openTextDocument(uriOf('src/multi.ts'));
        await vscode.window.showTextDocument(doc);
        await waitFor('document shows the agent version', () => doc.getText().includes('AI three'));
        assert.equal((await t.hunksFor(doc))!.length, 2);

        // User: edit line 1 (outside AI regions), not saved yet.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, 0, 6), 'USER 1');
        await vscode.workspace.applyEdit(edit);
        const hunks = (await t.hunksFor(doc))!;
        assert.deepEqual(
          hunks.map((h) => [h.start, h.addedCount, h.removedLines]),
          [
            [2, 1, ['line 3']],
            [7, 0, ['line 8']],
          ],
        );

        // After saving: the user's edit goes into the baseline, the AI hunks stay.
        await doc.save();
        await waitFor('baseline contains the user edit', async () => (await t.baselineText(doc.uri))?.startsWith('USER 1\n') === true);
        assert.equal(pending('src/multi.ts')?.kind, 'modified');
        assert.deepEqual(pending('src/multi.ts')!.stats, { added: 1, removed: 2 });
      },
    ],
    [
      'v0.2: Approve one hunk → only that hunk disappears',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/multi.ts'));
        const [first] = (await t.hunksFor(doc))!;
        await vscode.commands.executeCommand('laster.approveHunk', doc.uri.toString(), first.start);
        const hunks = (await t.hunksFor(doc))!;
        assert.equal(hunks.length, 1);
        assert.deepEqual(hunks[0].removedLines, ['line 8']);
        assert.ok(pending('src/multi.ts'));
      },
    ],
    [
      'v0.2: Revert the last hunk → content restored, file saved and dropped from the list',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/multi.ts'));
        const [last] = (await t.hunksFor(doc))!;
        await vscode.commands.executeCommand('laster.revertHunk', doc.uri.toString(), last.start);
        await waitFor('multi.ts not pending', () => !pending('src/multi.ts'));
        const expected = ['USER 1', 'line 2', 'AI three', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'];
        assert.equal(fs.readFileSync(file('src/multi.ts'), 'utf8'), expected.join('\n') + '\n');
        assert.equal(doc.isDirty, false);
      },
    ],
    [
      'v0.2: user manually undoes the AI change → automatically dropped from the list',
      async () => {
        const original = fs.readFileSync(file('src/manual.ts'), 'utf8');
        fs.writeFileSync(file('src/manual.ts'), original.replace('line 5\n', 'line 5\nAI extra\n'));
        await waitFor('manual.ts pending', () => !!pending('src/manual.ts'));
        const doc = await vscode.workspace.openTextDocument(uriOf('src/manual.ts'));
        await vscode.window.showTextDocument(doc);
        await waitFor('document shows the agent version', () => doc.getText().includes('AI extra'));
        // The user deletes the line where their cursor is.
        vscode.window.activeTextEditor!.selection = new vscode.Selection(5, 0, 5, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, new vscode.Range(5, 0, 6, 0));
        await vscode.workspace.applyEdit(edit);
        await waitFor('manual.ts not pending', () => !pending('src/manual.ts'));
      },
    ],
    [
      'v0.2: agent writes to an open file → not lost even before the editor reloads',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/race.ts'));
        await vscode.window.showTextDocument(doc);
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(file('src/race.ts'), fs.readFileSync(file('src/race.ts'), 'utf8') + `agent ${i}\n`);
          await new Promise((r) => setTimeout(r, 150));
        }
        await waitFor('race.ts pending', () => !!pending('src/race.ts'));
        await stays('race.ts stays pending', () => !!pending('src/race.ts'), 1500);
        await waitFor('3 agent lines highlighted', async () => (await t.hunksFor(doc))?.[0]?.addedCount === 3);
      },
    ],
    [
      'v0.2: CodeLens, hover, peek, and navigation are registered in the editor',
      async () => {
        const uri = uriOf('src/race.ts');
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
        const titles = lenses.map((l) => l.command?.title);
        assert.ok(titles.includes('✓ Approve') && titles.includes('↺ Revert'), `CodeLens: ${titles.join(', ')}`);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(10, 0));
        const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join('\n');
        assert.match(text, /Laster/);
        assert.match(text, /laster\.approveHunk/);

        const editor = await vscode.window.showTextDocument(uri);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('laster.nextHunk');
        assert.equal(vscode.window.activeTextEditor!.selection.active.line, 10);

        // Peek on a hunk that has old lines.
        fs.writeFileSync(file('src/race.ts'), fs.readFileSync(file('src/race.ts'), 'utf8').replace('line 2\n', 'line two\n'));
        await waitFor('replaced hunk shows up', async () => ((await t.hunksFor(editor.document)) ?? []).some((h) => h.removedLines.length > 0));
        const replaced = (await t.hunksFor(editor.document))!.find((h) => h.removedLines.length > 0)!;
        await vscode.commands.executeCommand('laster.peekHunk', uri.toString(), replaced.start);
      },
    ],
    [
      'v0.3: WorkspaceEdit on a file that is not in the active editor → pending, disk untouched',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/inedit.ts'));
        await vscode.window.showTextDocument(uriOf('src/user.ts'));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(2, 0, 3, 0), 'agent was here\n');
        await vscode.workspace.applyEdit(edit);
        await waitFor('inedit.ts pending', () => pending('src/inedit.ts')?.source === 'editor');
        assert.equal(fs.readFileSync(file('src/inedit.ts'), 'utf8').includes('agent was here'), false, 'disk untouched');
        const hunks = (await t.hunksFor(doc))!;
        assert.deepEqual(hunks.map((h) => [h.start, h.addedCount, h.removedLines]), [[2, 1, ['line 3']]]);
      },
    ],
    [
      'v0.3: Revert of an in-editor AI hunk is not flagged again',
      async () => {
        const doc = await vscode.workspace.openTextDocument(uriOf('src/inedit.ts'));
        await vscode.commands.executeCommand('laster.revertHunk', doc.uri.toString(), 2);
        await waitFor('inedit.ts not pending', () => !pending('src/inedit.ts'));
        await stays('inedit.ts stays clean', () => !pending('src/inedit.ts'), 1000);
      },
    ],
    [
      'v0.3: typing at the cursor → not pending',
      async () => {
        const editor = await vscode.window.showTextDocument(uriOf('src/typing.ts'));
        editor.selection = new vscode.Selection(4, 6, 4, 6);
        await vscode.commands.executeCommand('type', { text: ' typed by me' });
        await vscode.commands.executeCommand('type', { text: '\n' });
        await vscode.commands.executeCommand('type', { text: 'another line' });
        await stays('typing.ts not pending', () => !pending('src/typing.ts'), 1500);
        assert.ok(editor.document.getText().includes('line 5 typed by me\nanother line'));
      },
    ],
    [
      'v0.3: Undo of an in-editor AI edit → dropped from the list',
      async () => {
        const editor = await vscode.window.showTextDocument(uriOf('src/undo.ts'));
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(editor.document.uri, new vscode.Position(8, 0), 'ai 1\nai 2\nai 3\nai 4\n');
        await vscode.workspace.applyEdit(edit);
        await waitFor('undo.ts pending', () => !!pending('src/undo.ts'));
        await vscode.commands.executeCommand('undo');
        await waitFor('undo.ts not pending', () => !pending('src/undo.ts'));
      },
    ],
    [
      'v0.3: the inline-suggestion wrapper marks the accepted text as AI',
      async () => {
        // Ghost text does not render in the unfocused test window, so the accept itself is simulated:
        // the wrapper arms the AI intent and runs the built-in accept; the insertion it would make is a
        // small edit at the cursor, which would otherwise count as the user's typing.
        const editor = await vscode.window.showTextDocument(uriOf('src/inline.ts'));
        editor.selection = new vscode.Selection(2, 6, 2, 6);
        await vscode.commands.executeCommand('laster.acceptInlineSuggestion');
        await editor.edit((b) => b.insert(new vscode.Position(2, 6), ' // suggested by AI'));
        await waitFor('inline.ts pending as AI', () => pending('src/inline.ts')?.source === 'ai');

        // Without the wrapper, the same kind of edit is the user's typing.
        await new Promise((r) => setTimeout(r, 1500));
        editor.selection = new vscode.Selection(6, 6, 6, 6);
        await editor.edit((b) => b.insert(new vscode.Position(6, 6), ' // typed'));
        await new Promise((r) => setTimeout(r, 800));
        const hunks = (await t.hunksFor(editor.document))!;
        assert.deepEqual(
          hunks.map((h) => h.start),
          [2],
          'only the accepted suggestion is highlighted',
        );
      },
    ],
    [
      'v0.3: Tab / Cmd+Right are routed through the Laster wrapper while a suggestion is visible',
      async () => {
        const pkg = ext.packageJSON as { contributes: { keybindings: { command: string; key: string; mac?: string; when: string }[] } };
        const tab = pkg.contributes.keybindings.filter((k) => k.command === 'laster.acceptInlineSuggestion' && k.key === 'tab');
        assert.ok(tab.some((k) => k.when.includes('inlineSuggestionVisible') && k.when.includes('config.laster.trackInlineSuggestions')));
        const word = pkg.contributes.keybindings.find((k) => k.command === 'laster.acceptInlineSuggestionNextWord');
        assert.equal(word?.mac, 'cmd+right');
      },
    ],
    [
      'v0.3: Paste (wrapped) → yours; Paste as AI Code → AI',
      async () => {
        const editor = await vscode.window.showTextDocument(uriOf('src/pasted.ts'));
        await vscode.env.clipboard.writeText('pasted();\n'.repeat(6));
        editor.selection = new vscode.Selection(3, 0, 3, 0);
        await vscode.commands.executeCommand('laster.paste');
        await waitFor('pasted', () => editor.document.getText().includes('pasted();'));
        await stays('pasted.ts not pending', () => !pending('src/pasted.ts'), 1200);

        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('laster.pasteAsAi');
        await waitFor('pasted.ts pending as AI', () => pending('src/pasted.ts')?.source === 'ai');
        const hunks = (await t.hunksFor(editor.document))!;
        assert.equal(hunks.length, 1, 'only the AI paste is highlighted');
        assert.equal(hunks[0].start, 0);
      },
    ],
    [
      'v0.3: agent edits in the editor and saves right away (Cline style) → still pending',
      async () => {
        await vscode.window.showTextDocument(uriOf('src/user.ts'));
        const doc = await vscode.workspace.openTextDocument(uriOf('src/cline.ts'));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, 10, 0), 'rewritten by an agent\n');
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await waitFor('cline.ts pending', () => !!pending('src/cline.ts'));
        await stays('cline.ts stays pending', () => !!pending('src/cline.ts'), 1500);
        assert.equal(fs.readFileSync(file('src/cline.ts'), 'utf8'), 'rewritten by an agent\n');
        assert.deepEqual(pending('src/cline.ts')!.stats, { added: 1, removed: 10 });
      },
    ],
    [
      'v0.3: discarding unsaved edits with "Revert File" is not flagged',
      async () => {
        const editor = await vscode.window.showTextDocument(uriOf('src/discard.ts'));
        editor.selection = new vscode.Selection(3, 0, 3, 0);
        await vscode.commands.executeCommand('type', { text: 'draft ' });
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await waitFor('reverted', () => !editor.document.isDirty);
        await stays('discard.ts not pending', () => !pending('src/discard.ts'), 1500);
      },
    ],
    [
      'v0.3: file created through a WorkspaceEdit → pending added',
      async () => {
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uriOf('src/created.ts'), { contents: Buffer.from('created by an agent\n') });
        await vscode.workspace.applyEdit(edit);
        await waitFor('created.ts pending added', () => pending('src/created.ts')?.kind === 'added');
      },
    ],
    [
      'v0.3: the panel groups files into batches with hunk children',
      async () => {
        const roots = await api.reviewView.getChildren();
        assert.ok(roots.length >= 1 && roots.every((n) => n.type === 'batch'));
        const files = (await Promise.all(roots.map((r) => api.reviewView.getChildren(r)))).flat();
        const pastedNode = files.find((n) => n.type === 'file' && n.info.uri.path.endsWith('pasted.ts'))!;
        const hunks = await api.reviewView.getChildren(pastedNode);
        assert.equal(hunks.length, 1);
        assert.equal(hunks[0].type, 'hunk');
      },
    ],
    [
      'explorer: pending files get a "C" badge and every folder above them a "•"',
      async () => {
        fs.mkdirSync(file('src/deep/nested'), { recursive: true });
        fs.writeFileSync(file('src/deep/nested/leaf.ts'), 'agent file\n');
        await waitFor('leaf.ts pending', () => !!pending('src/deep/nested/leaf.ts'));
        await new Promise((r) => setTimeout(r, 100));
        const deco = (rel: string) => api.fileDecorations.provideFileDecoration(vscode.Uri.file(file(rel)));
        assert.equal(deco('src/deep/nested/leaf.ts')?.badge, 'C');
        for (const folder of ['src/deep/nested', 'src/deep', 'src', '.']) {
          assert.equal(deco(folder)?.badge, '•', `folder ${folder}`);
        }
        assert.match(deco('src/deep')!.tooltip!, /1 file pending review/);
        assert.equal(deco('src/user.ts'), undefined, 'clean files are not decorated');

        await t.approve(uriOf('src/deep/nested/leaf.ts'));
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(deco('src/deep/nested/leaf.ts'), undefined);
        assert.equal(deco('src/deep/nested'), undefined, 'folder marker goes away with its last pending file');
        assert.equal(deco('src')?.badge, '•', 'src still has other pending files');
      },
    ],
    [
      'git checkout → not pending (handled by the Git extension)',
      async () => {
        execFileSync('git', ['checkout', '-q', 'feature'], { cwd: ws });
        await stays('branchy.ts not pending', () => !pending('src/branchy.ts'), 2000);
        assert.equal(await t.baselineText(uriOf('src/branchy.ts')), 'feature version\n');
      },
    ],
    [
      'agent edits then immediately runs git add → stays pending',
      async () => {
        fs.writeFileSync(file('src/util.ts'), 'export const x = 2;\n');
        execFileSync('git', ['add', 'src/util.ts'], { cwd: ws });
        await waitFor('util.ts pending', () => pending('src/util.ts')?.kind === 'modified');
      },
    ],
  ];

  const failures: string[] = [];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (err) {
      console.log(`  ✘ ${name}\n    ${(err as Error).message}`);
      failures.push(name);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} integration tests failed`);
  }
}
