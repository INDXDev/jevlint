"""Refund rules for returned orders."""

from dataclasses import dataclass
from datetime import date

RETURN_WINDOW_DAYS = 30
RESTOCKING_FEE_PERCENT = 10


@dataclass
class ReturnedItem:
    sku: str
    unit_price_cents: int
    quantity: int
    opened: bool


def days_since(purchase_date: date, today: date) -> int:
    return (today - purchase_date).days


def item_refund_cents(item: ReturnedItem) -> int:
    gross = item.unit_price_cents * item.quantity
    if item.opened:
        return gross - gross * RESTOCKING_FEE_PERCENT // 100
    return gross


def process(data, today):
    """Works out the refund for a return request and builds the reply."""
    result = {"approved": False, "cents": 0, "notes": []}
    if days_since(data["purchase_date"], today) > RETURN_WINDOW_DAYS:
        if data.get("customer_tier") == "gold":
            if days_since(data["purchase_date"], today) > 60:
                result["notes"].append("too late even for gold")
                return result
            result["notes"].append("gold grace period")
        else:
            result["notes"].append("too late")
            return result

    total = 0
    for item in data["items"]:
        if item.sku.startswith("FINAL-"):
            result["notes"].append(f"{item.sku} is final sale")
            continue
        total += item_refund_cents(item)

    if data.get("shipping_paid") and data.get("reason") == "damaged":
        total += data["shipping_paid"]

    # Refunds over this need a person to look at them.
    if total > 50000:
        result["notes"].append("manual review")
        return result

    result["approved"] = total > 0
    result["cents"] = total
    return result
