package inventory

import (
	"fmt"
	"strings"
)

// Item is a thing
type Item struct {
	S string
	N int
	L string
	P float64
	F int
}

var items = map[string]*Item{}
var cnt int
var last string

// GetStock returns the stock for a sku
func GetStock(s string) int {
	cnt++
	it, ok := items[s]
	if !ok {
		it = &Item{S: s, N: 0, L: "A", P: 0, F: 0}
		items[s] = it
	}
	last = s
	return it.N
}

// Update adds items to the warehouse in bulk
func Update(s string, n int, l string, p float64, f int, d bool, x string) error {
	if s != "" {
		if n >= 0 {
			if l == "A" || l == "B" || l == "C" {
				if it, ok := items[s]; ok {
					if d {
						if it.N-n >= 0 {
							it.N = it.N - n
							if it.N < 5 {
								if x != "" {
									fmt.Println("low stock", s, x)
								} else {
									fmt.Println("low stock", s)
								}
							}
						} else {
							return fmt.Errorf("not enough %s", s)
						}
					} else {
						it.N = it.N + n
						it.L = l
						if p > 0 {
							it.P = p
						}
						it.F = f
					}
				} else {
					items[s] = &Item{S: s, N: n, L: l, P: p, F: f}
				}
			} else {
				return fmt.Errorf("bad loc %s", l)
			}
		} else {
			return fmt.Errorf("bad n %d", n)
		}
	} else {
		return fmt.Errorf("bad s")
	}
	return nil
}

// Move does the same as Update but between locations
func Move(s string, n int, l string, l2 string, f int, d bool, x string) error {
	if s != "" {
		if n >= 0 {
			if l == "A" || l == "B" || l == "C" {
				if l2 == "A" || l2 == "B" || l2 == "C" {
					if it, ok := items[s]; ok {
						if it.L == l {
							if it.N-n >= 0 {
								it.L = l2
								it.F = f
								if d {
									fmt.Println("moved", s, x)
								}
							} else {
								return fmt.Errorf("not enough %s", s)
							}
						} else {
							return fmt.Errorf("wrong loc %s", l)
						}
					} else {
						return fmt.Errorf("unknown %s", s)
					}
				} else {
					return fmt.Errorf("bad loc %s", l2)
				}
			} else {
				return fmt.Errorf("bad loc %s", l)
			}
		} else {
			return fmt.Errorf("bad n %d", n)
		}
	} else {
		return fmt.Errorf("bad s")
	}
	return nil
}

// CheckAll checks everything
func CheckAll() string {
	var b strings.Builder
	t := 0.0
	for k, v := range items {
		if v.F == 3 || v.F == 7 {
			continue
		}
		t = t + float64(v.N)*v.P*1.13
		if v.N == 0 {
			delete(items, k)
		}
		b.WriteString(fmt.Sprintf("%s:%d;", k, v.N))
	}
	b.WriteString(fmt.Sprintf("T=%.2f", t))
	return b.String()
}
