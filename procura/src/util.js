class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const posInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive whole number`);
  return n;
};
const str = (v, name, max = 255, required = true) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long`);
  return s;
};
const num = (v, name, min, max) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max)
    throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};
module.exports = { HttpError, ah, posInt, str, num };
