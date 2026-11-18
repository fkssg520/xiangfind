// 带前缀的随机 ID
import { randomBytes } from 'node:crypto';

export function makeId(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export const ID = {
  user: () => makeId('usr'),
  item: () => makeId('itm'),
  claim: () => makeId('clm'),
  message: () => makeId('msg'),
  point: () => makeId('stp'),
  image: () => makeId('img'),
  match: () => makeId('mtc'),
  token: () => makeId('tok'),
  audit: () => makeId('aud'),
};

export function nowIso() {
  return new Date().toISOString();
}
