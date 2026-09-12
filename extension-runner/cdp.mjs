import WebSocket from 'ws';

export class Cdp {
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map();
    ws.on('message', raw => {
      const data = JSON.parse(raw);
      const p = this.pending.get(data.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error.message)); else p.resolve(data.result);
    });
    ws.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser disconnected')); } this.pending.clear(); });
  }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(targetId) { return (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws.close(); }
}
