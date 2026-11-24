#!/usr/bin/env python3
"""生成 demo 用的小数据集。

真实项目里 train.jsonl 是 51 万行，这里缩到 2000 行，
只是为了 demo 能秒级跑完。行数是程序数出来的，不是写死的。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

SPECS = [
    ("data/smoke/train.jsonl", 100),
    ("data/smoke/eval.jsonl", 20),
    ("data/full/train.jsonl", 2000),
    ("data/full/eval.jsonl", 200),
]

for rel, n in SPECS:
    p = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        for i in range(n):
            f.write(json.dumps({"id": i, "text": "record %d" % i}, ensure_ascii=False) + "\n")
    print("wrote %-26s %5d lines" % (rel, n))
