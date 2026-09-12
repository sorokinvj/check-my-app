import { randomUUID } from 'node:crypto';

// A reference names an observed control, never a model-supplied selector or
// coordinate. Each reference is consumed before input. Sibling fields remain
// usable only if the fresh native lookup still matches the observed control.
export class NativeSurface {
  constructor(invoke, now = Date.now) { this.invoke = invoke; this.now = now; this.snapshot = null; this.credentialFilled = false; this.credentialSubmitted = false; this.secrets = new Map(); }
  invalidate() { this.snapshot = null; }
  async read(url, targetId) {
    const result = await this.invoke({ operation: 'read', url });
    for (const node of result.nodes) {
      if (/\.(pdf|docx?)$/i.test(node.name?.trim() ?? '')) this.secrets.set(node.name, '[existing document]');
    }
    const refs = new Map(result.nodes.map(node => [randomUUID(), node]));
    this.snapshot = { url, targetId, refs, at: this.now() };
    return { url, targetId, nodes: [...refs].map(([ref, n]) => ({ ref, name: n.name, role: n.role, placeholder: n.placeholder, protected: n.protected, editable: n.editable, enabled: n.enabled })) };
  }
  async act({ url, targetId, ref, operation, value, credential }) {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.url !== url || snapshot.targetId !== targetId || this.now() - snapshot.at > 60_000) throw new Error('Native reference expired; read the popup again');
    const node = snapshot.refs.get(ref);
    if (!node) throw new Error('Native reference does not belong to this popup');
    snapshot.refs.delete(ref);
    if (operation === 'click') {
      const reason = nativeActionRefusal(node);
      if (reason) throw new Error(reason);
      if (this.credentialFilled && /\b(log.?in|sign.?in|submit|continue)\b/i.test(node.name)) {
        if (this.credentialSubmitted) throw new Error('A credential submission was already attempted; repeating it is refused');
        this.credentialSubmitted = true;
      }
    } else if (operation !== 'fill' || !node.editable || typeof value !== 'string' || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid native field input');
    if (operation === 'fill' && (credential || node.protected)) {
      if (this.credentialSubmitted) throw new Error('A credential submission was already attempted; refilling it is refused');
      this.credentialFilled = true;
      if (value) this.secrets.set(value, node.protected ? '{{TEST_PASSWORD}}' : '{{TEST_EMAIL}}');
    }
    return this.invoke({ operation, url, node, ...(operation === 'fill' ? { value } : {}) });
  }
  redact(value) {
    if (typeof value === 'string') {
      for (const [secret, replacement] of [...this.secrets].sort((a, b) => b[0].length - a[0].length)) value = value.replaceAll(secret, replacement);
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(item)]));
    return value;
  }
}

export function nativeActionRefusal(node) {
  if (!node.enabled) return 'Native control is disabled';
  if (!['push button', 'menu item', 'link', 'check box', 'radio button', 'combo box', 'static', 'label'].includes(node.role)) return 'This native control has no supported action';
  if (!node.name.trim()) return 'An unnamed native control cannot be acted on safely';
  if (/\b(start|begin|record|capture|insights|practice|end session|stop session)\b/i.test(node.name)) return 'Session controls require the owned session tool and its verified Stop sequence';
  if (/\b(buy|purchase|pay|subscribe|upgrade|delete|remove|upload|send|invite|create|sign up|register)\b/i.test(node.name)) return 'This action changes account data or purchases access';
  return null;
}
