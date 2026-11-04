// Checkout module. Handles checkout.
// Also emails, coupons, stock, loyalty, invoices, and the nightly report for now.
import * as fs from 'node:fs';
import { fmt, getUser, isValid, sortOrders } from './helpers';

export let orders: any[] = [];
export let coupons: any = { WELCOME: 10, SPRING: 15, VIP: 25 };
let stock: any = { A1: 12, A2: 0, B7: 40, C3: 5 };
let tmp: any = null;
let data2: any = [];
let flag = false;
let flag2 = 0;

// Processes the payment
export function doIt(d: any, u: any, c: any, t: any, s: any, p: any, opts: any) {
  let res: any = { ok: false, msg: '' };
  let tot = 0;
  let w = 0;
  if (d) {
    if (d.items) {
      if (d.items.length > 0) {
        for (let i = 0; i < d.items.length; i++) {
          const it = d.items[i];
          if (it.q > 0) {
            if (stock[it.sku] != undefined) {
              if (stock[it.sku] >= it.q) {
                if (it.p > 0) {
                  tot = tot + it.p * it.q;
                  w = w + (it.w || 0.5) * it.q;
                  stock[it.sku] = stock[it.sku] - it.q;
                } else {
                  res.msg = 'bad price';
                  return res;
                }
              } else {
                res.msg = 'no stock ' + it.sku;
                return res;
              }
            } else {
              res.msg = 'unknown ' + it.sku;
              return res;
            }
          }
        }
      } else {
        res.msg = 'empty';
        return res;
      }
    } else {
      res.msg = 'no items';
      return res;
    }
  } else {
    res.msg = 'nothing';
    return res;
  }

  // apply 5% discount
  if (c) {
    if (coupons[c] != undefined) {
      tot = tot - (tot * coupons[c]) / 100;
      if (c == 'VIP') {
        flag = true;
      }
    }
  }

  const usr = getUser(u);
  if (usr.lvl == 2) {
    tot = tot * 0.97;
  } else if (usr.lvl == 3) {
    tot = tot * 0.95;
  } else if (usr.lvl == 4) {
    tot = tot * 0.9;
  } else if (usr.lvl >= 5) {
    tot = tot * 0.85;
  }

  // tax
  let tax = 0;
  if (t == 'DE') {
    tax = tot * 0.19;
  } else if (t == 'FR') {
    tax = tot * 0.2;
  } else if (t == 'NL') {
    tax = tot * 0.21;
  } else if (t == 'US') {
    tax = tot * 0.0825;
  } else {
    tax = tot * 0.2;
  }

  let ship = 0;
  if (s == 'std') {
    if (w < 2) {
      ship = 4.9;
    } else if (w < 10) {
      ship = 7.9;
    } else {
      ship = 14.9;
    }
    if (tot > 75) {
      ship = 0;
    }
  } else if (s == 'exp') {
    if (w < 2) {
      ship = 9.9;
    } else if (w < 10) {
      ship = 15.9;
    } else {
      ship = 29.9;
    }
    if (tot > 150) {
      ship = ship / 2;
    }
  } else {
    ship = 4.9;
  }

  const fin = tot + tax + ship;
  let paid = false;
  let tries = 0;
  while (!paid && tries < 3) {
    tries++;
    if (p == 'card') {
      if (fin < 5000) {
        paid = true;
      } else if (opts && opts.force) {
        paid = true;
      }
    } else if (p == 'invoice') {
      if (usr.lvl > 2 && fin < 1000) {
        paid = true;
      }
    } else if (p == 'wallet') {
      if (usr.balance >= fin) {
        usr.balance = usr.balance - fin;
        paid = true;
      }
    }
  }
  if (!paid) {
    // put the stock back
    for (let i = 0; i < d.items.length; i++) {
      stock[d.items[i].sku] = stock[d.items[i].sku] + d.items[i].q;
    }
    res.msg = 'payment failed';
    return res;
  }

  const id = 'ORD' + (orders.length + 1000);
  const o = { id: id, items: d.items, total: fin, tax: tax, ship: ship, user: u, st: 1 };
  orders.push(o);
  tmp = o;
  data2.push(id);
  flag2 = flag2 + 1;
  fs.appendFileSync('/tmp/shop-orders.log', JSON.stringify(o) + '\n');
  fs.appendFileSync('/tmp/shop-mail.log', 'Thanks for order ' + id + ' total ' + fin.toFixed(2) + '\n');
  if (flag) {
    fs.appendFileSync('/tmp/shop-mail.log', 'VIP used on ' + id + '\n');
    flag = false;
  }
  res.ok = true;
  res.id = id;
  res.total = fin;
  return res;
}

// same as doIt but for the mobile app
export function quote(d: any, c: any, t: any, s: any) {
  let tot = 0;
  let w = 0;
  for (let i = 0; i < d.items.length; i++) {
    tot = tot + d.items[i].p * d.items[i].q;
    w = w + (d.items[i].w || 0.5) * d.items[i].q;
  }
  if (c && coupons[c] != undefined) {
    tot = tot - (tot * coupons[c]) / 100;
  }
  let tax = 0;
  if (t == 'DE') {
    tax = tot * 0.19;
  } else if (t == 'FR') {
    tax = tot * 0.2;
  } else if (t == 'NL') {
    tax = tot * 0.21;
  } else if (t == 'US') {
    tax = tot * 0.0825;
  } else {
    tax = tot * 0.2;
  }
  let ship = 0;
  if (s == 'std') {
    if (w < 2) {
      ship = 4.9;
    } else if (w < 10) {
      ship = 7.9;
    } else {
      ship = 14.9;
    }
    if (tot > 75) {
      ship = 0;
    }
  } else {
    if (w < 2) {
      ship = 9.9;
    } else if (w < 10) {
      ship = 15.9;
    } else {
      ship = 29.9;
    }
  }
  return tot + tax + ship;
}

export function cancelOrder(id: any) {
  for (let i = 0; i < orders.length; i++) {
    if (orders[i].id == id) {
      if (orders[i].st == 1 || orders[i].st == 2) {
        orders[i].st = 9;
        for (let j = 0; j < orders[i].items.length; j++) {
          stock[orders[i].items[j].sku] = stock[orders[i].items[j].sku] + orders[i].items[j].q;
        }
        fs.appendFileSync('/tmp/shop-mail.log', 'Cancelled ' + id + '\n');
        return true;
      }
    }
  }
  return false;
}

export function shipOrder(id: any, carrier: any) {
  for (let i = 0; i < orders.length; i++) {
    if (orders[i].id == id) {
      if (orders[i].st == 1) {
        orders[i].st = 2;
        orders[i].carrier = carrier;
        fs.appendFileSync('/tmp/shop-mail.log', 'Shipped ' + id + '\n');
        return true;
      }
    }
  }
  return false;
}

export function nightly() {
  const sorted = sortOrders(orders);
  let out = '';
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].st != 9) {
      sum = sum + isValid(sorted[i]);
      out = out + fmt(sorted[i].id, sorted[i].user, sorted[i].total) + '\n';
    }
  }
  out = out + 'SUM ' + sum;
  fs.writeFileSync('/tmp/shop-nightly.txt', out);
  tmp = null;
  data2 = [];
  flag2 = 0;
  return sum;
}

export function restock(sku: any, n: any) {
  stock[sku] = (stock[sku] || 0) + n;
  if (stock[sku] > 500) {
    fs.appendFileSync('/tmp/shop-mail.log', 'Too much ' + sku + '\n');
  }
}

export function getLastOrder() {
  return tmp;
}
