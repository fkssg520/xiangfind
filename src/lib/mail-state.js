// 邮件通道运行时状态（供 /health 暴露，演示前一眼看出邮件是否正常）
// 为什么需要：SMTP 配了但 535/超时时，接口只会返回 delivery 原因，运维看不到"最近一次发信成功没"。
let state = {
  configured: false,
  attempts: 0,
  delivered: 0,
  failed: 0,
  lastResult: null, // 'delivered' | 'smtp_not_configured' | 'nodemailer_missing' | 'send_failed'
  lastAt: null,
  lastError: null,
};

export function recordAttempt(outcome) {
  state.attempts += 1;
  state.configured = outcome.configured;
  if (outcome.delivered) {
    state.delivered += 1;
    state.lastResult = 'delivered';
    state.lastError = null;
  } else {
    state.failed += 1;
    state.lastResult = outcome.reason || 'failed';
    state.lastError = outcome.error ? String(outcome.error).slice(0, 200) : null;
  }
  state.lastAt = new Date().toISOString();
}

export function mailState() {
  return { ...state };
}

// 测试用：重置
export function resetMailState() {
  state = { configured: false, attempts: 0, delivered: 0, failed: 0, lastResult: null, lastAt: null, lastError: null };
}
