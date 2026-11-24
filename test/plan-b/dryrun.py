#!/usr/bin/env python3
"""最小可用的 --dry-run：只做一件事——
把「我实际会读什么、跑多少步」打印成 JSON，什么都不跑。

用法:
    python test/plan-b/dryrun.py --config test/plan-b/config.smoke.json
    python test/plan-b/dryrun.py --config test/plan-b/config.smoke.json > .agent/resolved.json

设计约束（很重要，抄的时候别破坏）:
  1. 只输出事实，不输出意图。
  2. 所有数字必须是**现场量出来的**，不能写死。
  3. scope 必须从 config 读，不能在脚本里硬编码成 "full"。
     否则这个 dry-run 就变成了另一份"自我报告"，等于白做。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def count_lines(path):
    with open(path, "rb") as f:
        return sum(1 for _ in f)


def resolve(cfg_path, root):
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)

    inputs = []
    for item in cfg["data"]:
        rel = item["path"]
        abs_path = os.path.join(root, rel)
        rec = {
            "role": item["role"],
            "path": rel,  # 保持相对路径，便于契约对比
            "purpose": item.get("purpose", "unknown"),
        }
        if os.path.exists(abs_path):
            rec["lines"] = count_lines(abs_path)
            rec["bytes"] = os.path.getsize(abs_path)
        else:
            rec["lines"] = None
            rec["bytes"] = None
            rec["missing"] = True
        if item.get("derived_from"):
            rec["derived_from"] = item["derived_from"]
            rec["derivation"] = item.get("derivation", "")
        inputs.append(rec)

    return {
        "schema": "cg.resolved/1",
        "project": cfg.get("project", ""),
        "stage": cfg.get("stage", "train"),
        # ← 整个 B 的核心字段：脚本自己承认这次按什么规模跑
        "scope": cfg["scope"],
        "inputs": inputs,
        "params": cfg.get("params", {}),
        "outputs": [{"role": "ckpt", "path": cfg.get("output_dir", "")}],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=HERE, help="路径解析基准，默认本脚本所在目录")
    args = ap.parse_args()

    # Windows 下重定向时 stdout 默认是 GBK，会被下游当成 UTF-8 读出乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    out = resolve(args.config, args.root)
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
