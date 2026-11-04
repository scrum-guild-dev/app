// 対象を選んでも全件 skip なら、その画面を検査した成功記録にはしない。
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class ExecutedReporter implements Reporter {
  private executed = 0;

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') this.executed++;
  }

  onEnd(result: FullResult): { status: 'failed' } | undefined {
    if (this.executed === 0 && result.status === 'passed') {
      console.error('e2e:preflight: 実行されたテストが0件（全件省略を含む）。関連する対象を選び直す');
      return { status: 'failed' };
    }
  }
}
