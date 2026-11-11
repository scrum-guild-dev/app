// PreToolUse（mcp__github__*）の入口。判定は mcp-rules.mjs。
// import されない前提で、起動されたら必ず判定する。判定できないときは exit 2 で止める（onFailure を読まない古い Claude Code でも止まるように）。
// 判定のモジュールは try の中で読み込む。静的に import すると、読み込みの失敗が exit 1（素通り）になる。
import { readFileSync } from 'node:fs';

try {
  const { judgeMcp } = await import('./mcp-rules.mjs');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const verdict = judgeMcp(input.tool_name, input.tool_input ?? {});
  if (verdict) {
    const [decision, reason] = verdict;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: `${reason}（.claude/hooks/mcp-rules.mjs）`,
        },
      }),
    );
  }
} catch (error) {
  process.stderr.write(`guard-mcp: 判定できなかったので止めました: ${error.message}\n`);
  process.exit(2);
}
