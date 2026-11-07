import { describe, expect, test } from 'vitest';
import { moveFailureMessage } from './move-failure.ts';
import { completionFailureMessage } from './story-completion.ts';

function conflict(reason: string, code = 'conflict') {
  return { status: 409, error: { code, details: { reason } } };
}

describe('completionFailureMessage', () => {
  test('未完了のタスクが残っている、すでに完了している、親が完了している、は理由の文を返し、木を読み直す', () => {
    expect(completionFailureMessage(conflict('open_tasks'), 'complete')).toEqual({
      message: '未完了のタスクが残っているため、完了にできません。一覧を読み直します',
      reload: true,
    });
    expect(completionFailureMessage(conflict('completed'), 'complete').message).toContain('すでに完了です');
    expect(completionFailureMessage(conflict('parent_completed'), 'complete').message).toContain('完了にできません');
    expect(completionFailureMessage(conflict('parent_completed'), 'reopen').message).toContain('取り消せません');
  });

  test('見つからない（404）は読み直し、通信や 5xx は読み直さない', () => {
    expect(completionFailureMessage({ status: 404, error: null }, 'reopen')).toEqual({
      message: 'このストーリーは見つかりません。一覧を読み直します',
      reload: true,
    });
    expect(completionFailureMessage({ status: 503, error: null }, 'complete')).toEqual({
      message: '完了にできませんでした。もう一度試してください。',
      reload: false,
    });
    expect(completionFailureMessage({ status: 0, error: null }, 'reopen')).toEqual({
      message: '取り消せませんでした。もう一度試してください。',
      reload: false,
    });
  });

  test('終了したワークスペース（workspace_closed）は書き込めない文で、読み直す', () => {
    const result = completionFailureMessage({ status: 409, error: { code: 'workspace_closed' } }, 'complete');
    expect(result).toEqual({ message: '終了したワークスペースには書き込めません', reload: true });
  });

  test('理由が分からない 409 は、ふつうの失敗の文で、読み直す', () => {
    expect(completionFailureMessage({ status: 409, error: { code: 'conflict' } }, 'complete')).toEqual({
      message: '完了にできませんでした。もう一度試してください。',
      reload: true,
    });
  });
});

describe('moveFailureMessage', () => {
  test('親が完了している移動は、動かした行の種類で文を変える', () => {
    expect(moveFailureMessage(conflict('parent_completed'), 'story')).toContain('エピック');
    expect(moveFailureMessage(conflict('parent_completed'), 'task')).toContain('ストーリー');
  });

  test('見つからないと、それ以外の失敗は決まった文', () => {
    expect(moveFailureMessage({ status: 404, error: null }, 'story')).not.toBe(
      moveFailureMessage({ status: 500, error: null }, 'story'),
    );
  });
});
