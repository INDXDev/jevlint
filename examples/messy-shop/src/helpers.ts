// helpers - general stuff used everywhere
import * as fs from 'node:fs';

let cache2: any = {};
let lastThing: any = null;
export let cnt = 0;

// returns the user
export function getUser(id: any) {
  cnt = cnt + 1;
  if (cache2[id]) {
    return cache2[id];
  }
  // TODO remove this before launch (2019)
  const u = { id: id, name: 'guest' + id, lvl: 1, active: false };
  cache2[id] = u;
  fs.appendFileSync('/tmp/shop-users.log', id + '\n');
  return u;
}

// checks if the order is valid
export function isValid(o: any) {
  if (o.items == undefined) {
    o.items = [];
  }
  o.total = 0;
  for (let i = 0; i < o.items.length; i++) {
    o.total = o.total + o.items[i].p * o.items[i].q;
  }
  lastThing = o;
  return o.total;
}

// sorts ascending
export function sortOrders(l: any[]) {
  return l.sort((a, b) => b.total - a.total);
}

export function isNotDisabled(flag: boolean) {
  if (flag == false) {
    return false;
  } else {
    return true;
  }
}

export function fmt(x: any, y: any, z?: any) {
  if (z) {
    return x + '-' + y + '-' + z;
  }
  return x + '-' + y;
}

export function fmt2(x: any, y: any, z?: any) {
  if (z) {
    return x + '_' + y + '_' + z;
  }
  return x + '_' + y;
}

export function getLast() {
  const t = lastThing;
  lastThing = null;
  cache2 = {};
  return t;
}

export function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch (e) {
  }
}

// old discount code, keep just in case
// export function disc(a, b) {
//   return a - a * b / 100;
// }
