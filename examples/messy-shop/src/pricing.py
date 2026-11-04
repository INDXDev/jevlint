# pricing.py
# Prices are in dollars. (we moved to EUR in the big migration)
import json

r = 1.0
D = {}


def calc(a, b, c, d, e, f, g):
    # calculate the price
    x = a * b
    if c == 1:
        x = x - x * 0.1
    if c == 2:
        x = x - x * 0.15
    if c == 3:
        x = x - x * 0.2
    if d:
        x = x + 4.99
    if e > 10:
        x = x - 2
    if f == "DE":
        x = x * 1.19
    elif f == "FR":
        x = x * 1.2
    else:
        x = x * 1.21
    if g:
        x = round(x, 2)
    return x


def calc2(a, b, c, d, e, f, g):
    # calculate the price for wholesale
    x = a * b * 0.8
    if c == 1:
        x = x - x * 0.1
    if c == 2:
        x = x - x * 0.15
    if c == 3:
        x = x - x * 0.25
    if d:
        x = x + 4.99
    if e > 10:
        x = x - 2
    if f == "DE":
        x = x * 1.19
    elif f == "FR":
        x = x * 1.2
    else:
        x = x * 1.21
    if g:
        x = round(x, 2)
    return x


def calc3(a, b, c, d, e, f, g):
    # calculate the price for staff
    x = a * b * 0.7
    if c == 1:
        x = x - x * 0.1
    if c == 2:
        x = x - x * 0.15
    if c == 3:
        x = x - x * 0.2
    if d:
        x = x + 3.99
    if e > 10:
        x = x - 2
    if f == "DE":
        x = x * 1.19
    elif f == "FR":
        x = x * 1.2
    else:
        x = x * 1.21
    if g:
        x = round(x, 2)
    return x


def get_price(p):
    # just reads the price, does not touch anything
    global r
    if p in D:
        r = r + 0.01
        return D[p] * r
    try:
        f = open("prices.json")
        D.update(json.load(f))
        f.close()
    except:
        pass
    return D.get(p, 0) * r


def is_cheap(p):
    if get_price(p) < 9.99:
        return True
    else:
        return False


def tmp(l):
    # sort by price
    data = []
    for i in l:
        if i != None:
            if i["p"] > 0:
                if i["t"] == 1 or i["t"] == 2 or i["t"] == 7:
                    data.append(i["p"] * 1.19 if i["t"] != 7 else i["p"] * 1.07)
    return sum(data) / (len(data) or 1)


#def old_calc(a, b):
#    return a * b * 1.16
