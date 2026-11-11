import { describe, expect, it } from 'vitest';
import { resultError } from '../src/tasks/runner';

describe('resultError (SDK result message)', () => {
  it('null on success', () => {
    expect(resultError({ subtype: 'success', is_error: false, result: 'xong' })).toBeNull();
  });

  it('usage limit: subtype "success" + is_error shows the reason Claude wrote, not "success"', () => {
    expect(resultError({ subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets 10am (Asia/Ho_Chi_Minh)" }))
      .toBe("You've hit your weekly limit · resets 10am (Asia/Ho_Chi_Minh)");
    expect(resultError({ subtype: 'success', is_error: true, result: '  ', errors: ['API Error: 529'] })).toBe('API Error: 529');
    expect(resultError({ subtype: 'success', is_error: true })).toMatch(/không ghi lý do/);
  });

  it('other subtypes keep the subtype and the errors', () => {
    expect(resultError({ subtype: 'error_max_turns', is_error: true })).toBe('error_max_turns');
    expect(resultError({ subtype: 'error_during_execution', errors: ['boom', ''] })).toBe('error_during_execution: boom');
  });
});
