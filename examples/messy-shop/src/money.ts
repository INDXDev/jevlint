/** Money as whole minor units (cents), so sums never pick up floating-point error. */

export type Currency = 'EUR' | 'USD';

export interface Money {
  readonly cents: number;
  readonly currency: Currency;
}

const CENTS_PER_UNIT = 100;

export function money(cents: number, currency: Currency): Money {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Money needs whole cents, got ${cents}`);
  }
  return { cents, currency };
}

export function add(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.cents + right.cents, left.currency);
}

export function sum(amounts: readonly Money[], currency: Currency): Money {
  return amounts.reduce(add, money(0, currency));
}

/** Rounds half up, which is what our fictional tax office expects on invoices. */
export function percentOf(amount: Money, percent: number): Money {
  return money(Math.round((amount.cents * percent) / 100), amount.currency);
}

export function format(amount: Money): string {
  return `${(amount.cents / CENTS_PER_UNIT).toFixed(2)} ${amount.currency}`;
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new TypeError(`Cannot combine ${left.currency} with ${right.currency}`);
  }
}
