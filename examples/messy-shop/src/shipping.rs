// Shipping cost calculation (all prices in pounds)
use std::collections::HashMap;

pub struct Pkg {
    pub w: f64,
    pub l: f64,
    pub z: u8,
    pub t: i32,
}

// Returns the cost in cents
pub fn cost(p: &Pkg, a: bool, b: bool, c: bool, d: i32, e: &str, f: f64) -> f64 {
    let mut r = 0.0;
    if p.z == 1 {
        if p.w < 1.0 {
            r = 3.5;
        } else if p.w < 5.0 {
            r = 6.25;
        } else {
            r = 11.0;
        }
    } else if p.z == 2 {
        if p.w < 1.0 {
            r = 5.5;
        } else if p.w < 5.0 {
            r = 9.25;
        } else {
            r = 17.0;
        }
    } else if p.z == 3 {
        if p.w < 1.0 {
            r = 8.5;
        } else if p.w < 5.0 {
            r = 14.25;
        } else {
            r = 26.0;
        }
    }
    if a {
        r = r * 1.5;
    }
    if b {
        r = r + 2.75;
    }
    if c && d > 3 {
        r = r - 1.0;
    }
    if e == "fragile" {
        r = r + 4.0;
    }
    if p.l > 120.0 {
        r = r * 1.3;
    }
    r + f
}

pub fn estimate_days(p: &Pkg, a: bool) -> i32 {
    let mut n = 0;
    if p.z == 1 {
        n = 2;
    } else if p.z == 2 {
        n = 4;
    } else if p.z == 3 {
        n = 9;
    }
    if a {
        n = n / 2;
    }
    if p.t == 7 {
        n = n + 1;
    }
    n
}

pub fn summary(ps: &[Pkg]) -> HashMap<u8, f64> {
    let mut m = HashMap::new();
    for p in ps {
        let x = cost(p, false, false, false, 0, "", 0.0);
        let e = m.entry(p.z).or_insert(0.0);
        *e = *e + x;
    }
    m
}

pub fn is_heavy(p: &Pkg) -> bool {
    if p.w > 5.0 {
        return true;
    } else {
        return false;
    }
}
