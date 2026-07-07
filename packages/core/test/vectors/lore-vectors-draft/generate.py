#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def digest(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def spliced(body, sig=None, override_digest=None):
    h = override_digest or digest(body)
    suffix = f',"digest":"sha256:{h}"'
    if sig is not None:
        suffix += f',"sig":"{sig}"'
    return body[:-1] + suffix + "}"


def event(id_, kind="lore/artifact", at="2026-07-06T04:10:00Z", author=None, parents=None, payload=None, **extra):
    obj = {
        "v": 1,
        "id": id_,
        "kind": kind,
        "at": at,
        "author": author or {"actor": "deepfates"},
        "parents": parents if parents is not None else [],
        "payload": payload if payload is not None else {},
    }
    obj.update(extra)
    return obj


def write_fixture(name, files, expected):
    d = ROOT / name
    d.mkdir(parents=True, exist_ok=True)
    for filename, lines, final_lf in files:
        data = "\n".join(lines)
        if final_lf:
            data += "\n"
        with (d / filename).open("w", encoding="utf-8", newline="") as f:
            f.write(data)
    (d / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def line(id_, **kwargs):
    return dump(event(id_, **kwargs))


def main():
    # 01: accepted lines, optional line metadata, signature preservation, final missing LF.
    a = line("018f0000-0000-7000-8000-000000000001", payload={"text": "root"})
    b = line("018f0000-0000-7000-8000-000000000002", parents=["018f0000-0000-7000-8000-000000000001"], payload={"text": "digested child", "digest": "payload-ok", "sig": "payload-ok"})
    c = line("018f0000-0000-7000-8000-000000000003", parents=["018f0000-0000-7000-8000-000000000002"], payload={"text": "signed child"}, marked="2026-07-06T05:00:00Z")
    d = line("018f0000-0000-7000-8000-000000000004", at="2026-07-06t04:10:03z", payload={"text": "lowercase timestamp accepted"})
    write_fixture("01-valid-events", [("input.lore", [a, spliced(b), spliced(c, "QUJDRA=="), d], False)], {
        "fixture": "01-valid-events",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000001", "has_digest": False, "has_sig": False},
            {"file": "input.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000002", "has_digest": True, "has_sig": False},
            {"file": "input.lore", "line": 3, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000003", "has_digest": True, "has_sig": True},
            {"file": "input.lore", "line": 4, "class": "nonconforming", "id": "018f0000-0000-7000-8000-000000000004", "reason": "final line missing LF; still accepted and view-eligible"},
        ],
        "union_event_ids": [
            "018f0000-0000-7000-8000-000000000001",
            "018f0000-0000-7000-8000-000000000002",
            "018f0000-0000-7000-8000-000000000003",
            "018f0000-0000-7000-8000-000000000004",
        ],
        "view_eligible_ids": [
            "018f0000-0000-7000-8000-000000000001",
            "018f0000-0000-7000-8000-000000000002",
            "018f0000-0000-7000-8000-000000000003",
            "018f0000-0000-7000-8000-000000000004",
        ],
        "views": {
            "downset:018f0000-0000-7000-8000-000000000003": {
                "ids": [
                    "018f0000-0000-7000-8000-000000000001",
                    "018f0000-0000-7000-8000-000000000002",
                    "018f0000-0000-7000-8000-000000000003",
                ],
                "partial": False,
                "obstacles": [],
            }
        },
    })

    # 02: splice detection must be anchored; marker-like bytes in payload are body bytes.
    marker = ',"digest":"sha256:' + "0" * 64 + '"}'
    p1 = line("018f0000-0000-7000-8000-000000000011", payload={"text": f"payload contains marker bytes {marker} and keeps going"})
    p2 = line("018f0000-0000-7000-8000-000000000012", payload={"text": "body has reserved words at the end", "digest": "payload name", "sig": "payload name"})
    near_splice = line("018f0000-0000-7000-8000-000000000013", payload={"text": "near"})[:-1] + ',"digest":"sha256:' + "a" * 63 + '"}'
    top_reserved = line("018f0000-0000-7000-8000-000000000014", payload={"text": "reserved top level"})[:-1] + ',"digest":"not-line-metadata"}'
    write_fixture("02-splice-anchoring", [("input.lore", [spliced(p1), spliced(p2), near_splice, top_reserved], True)], {
        "fixture": "02-splice-anchoring",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000011", "reason": "payload marker-like bytes are not a splice"},
            {"file": "input.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000012", "reason": "reserved names inside payload are allowed"},
            {"file": "input.lore", "line": 3, "class": "garbage", "reason": "near-splice is body; parsed body contains reserved top-level digest"},
            {"file": "input.lore", "line": 4, "class": "garbage", "reason": "top-level digest in body is reserved"},
        ],
        "union_event_ids": ["018f0000-0000-7000-8000-000000000011", "018f0000-0000-7000-8000-000000000012"],
        "view_eligible_ids": ["018f0000-0000-7000-8000-000000000011", "018f0000-0000-7000-8000-000000000012"],
    })

    # 03: digest mismatch wins over parse/envelope inspection.
    damaged_body = line("018f0000-0000-7000-8000-000000000021", payload={"text": "tampered"})
    dup_inside_damaged = '{"v":1,"id":"018f0000-0000-7000-8000-000000000022","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"deepfates"},"parents":[],"payload":{"x":1,"x":2}}'
    write_fixture("03-damaged-digest", [("input.lore", [spliced(damaged_body, override_digest="f" * 64), spliced(dup_inside_damaged, override_digest="e" * 64)], True)], {
        "fixture": "03-damaged-digest",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "damaged", "reason": "sha256 mismatch"},
            {"file": "input.lore", "line": 2, "class": "damaged", "reason": "sha256 mismatch; do not parse duplicate member names after damage"},
        ],
        "union_event_ids": [],
        "view_eligible_ids": [],
    })

    # 04: garbage classes.
    good_after_bad = line("018f0000-0000-7000-8000-000000000031", payload={"text": "good after bad"})
    garbage_lines = [
        '{"v":1,"id":"dup-depth","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"a"},"parents":[],"payload":{"x":1,"x":2}}',
        ' {"v":1,"id":"leading-space","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"a"},"parents":[],"payload":{}}',
        '{"v":1,"id":"bad-kind","kind":"lorename","at":"2026-07-06T04:10:00Z","author":{"actor":"a"},"parents":[],"payload":{}}',
        '{"v":2,"id":"unimplemented-v","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"a"},"parents":[],"payload":{}}',
        '',
        '{"v":1,"id":"crlf","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"a"},"parents":[],"payload":{}}\r',
        spliced(good_after_bad),
    ]
    write_fixture("04-garbage-classes", [("input.lore", garbage_lines, True)], {
        "fixture": "04-garbage-classes",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "garbage", "reason": "duplicate member name at nested object depth"},
            {"file": "input.lore", "line": 2, "class": "garbage", "reason": "bytes outside object: leading whitespace"},
            {"file": "input.lore", "line": 3, "class": "garbage", "reason": "kind lacks namespace/name slash"},
            {"file": "input.lore", "line": 4, "class": "garbage", "reason": "unimplemented v"},
            {"file": "input.lore", "line": 5, "class": "garbage", "reason": "empty line"},
            {"file": "input.lore", "line": 6, "class": "garbage", "reason": "CR before LF is trailing content"},
            {"file": "input.lore", "line": 7, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000031"},
        ],
        "union_event_ids": ["018f0000-0000-7000-8000-000000000031"],
        "view_eligible_ids": ["018f0000-0000-7000-8000-000000000031"],
    })

    # 05: duplicate sightings and same-id conflicts.
    same = line("018f0000-0000-7000-8000-000000000041", payload={"text": "same event"})
    same_alt_meta = spliced(same, "QUJDRA==")
    conflict_a = line("018f0000-0000-7000-8000-000000000042", payload={"text": "variant A"})
    conflict_b = line("018f0000-0000-7000-8000-000000000042", payload={"text": "variant B"})
    meta_disagree_body = line("018f0000-0000-7000-8000-000000000043", payload={"text": "metadata disagreement"})
    write_fixture("05-conflicts-and-duplicates", [("input.lore", [spliced(same), spliced(same), same_alt_meta, spliced(conflict_a), spliced(conflict_b), spliced(meta_disagree_body), meta_disagree_body], True)], {
        "fixture": "05-conflicts-and-duplicates",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000041"},
            {"file": "input.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000041", "duplicate_sighting": True},
            {"file": "input.lore", "line": 3, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000041", "duplicate_sighting": True, "metadata_disagreement": True},
            {"file": "input.lore", "line": 4, "class": "conflict-variant", "id": "018f0000-0000-7000-8000-000000000042"},
            {"file": "input.lore", "line": 5, "class": "conflict-variant", "id": "018f0000-0000-7000-8000-000000000042"},
            {"file": "input.lore", "line": 6, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000043"},
            {"file": "input.lore", "line": 7, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000043", "duplicate_sighting": True, "metadata_disagreement": True},
        ],
        "union_event_ids": ["018f0000-0000-7000-8000-000000000041", "018f0000-0000-7000-8000-000000000043"],
        "conflict_ids": ["018f0000-0000-7000-8000-000000000042"],
        "view_eligible_ids": ["018f0000-0000-7000-8000-000000000041", "018f0000-0000-7000-8000-000000000043"],
    })

    # 06: cycles, dangling parents, and conflict parent obstacles.
    ca = line("018f0000-0000-7000-8000-000000000051", parents=["018f0000-0000-7000-8000-000000000052"], payload={"text": "cycle A"})
    cb = line("018f0000-0000-7000-8000-000000000052", parents=["018f0000-0000-7000-8000-000000000051"], payload={"text": "cycle B"})
    child_cycle = line("018f0000-0000-7000-8000-000000000053", parents=["018f0000-0000-7000-8000-000000000051"], payload={"text": "descendant of cycle"})
    dangling = line("018f0000-0000-7000-8000-000000000054", parents=["018f0000-0000-7000-8000-00000000ffff"], payload={"text": "dangling parent"})
    conf_a = line("018f0000-0000-7000-8000-000000000055", payload={"text": "conflicted parent A"})
    conf_b = line("018f0000-0000-7000-8000-000000000055", payload={"text": "conflicted parent B"})
    child_conf = line("018f0000-0000-7000-8000-000000000056", parents=["018f0000-0000-7000-8000-000000000055"], payload={"text": "child of conflicted id"})
    write_fixture("06-graph-obstacles", [("input.lore", [spliced(ca), spliced(cb), spliced(child_cycle), spliced(dangling), spliced(conf_a), spliced(conf_b), spliced(child_conf)], True)], {
        "fixture": "06-graph-obstacles",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000051"},
            {"file": "input.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000052"},
            {"file": "input.lore", "line": 3, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000053"},
            {"file": "input.lore", "line": 4, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000054"},
            {"file": "input.lore", "line": 5, "class": "conflict-variant", "id": "018f0000-0000-7000-8000-000000000055"},
            {"file": "input.lore", "line": 6, "class": "conflict-variant", "id": "018f0000-0000-7000-8000-000000000055"},
            {"file": "input.lore", "line": 7, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000056"},
        ],
        "union_event_ids": [
            "018f0000-0000-7000-8000-000000000051",
            "018f0000-0000-7000-8000-000000000052",
            "018f0000-0000-7000-8000-000000000053",
            "018f0000-0000-7000-8000-000000000054",
            "018f0000-0000-7000-8000-000000000056",
        ],
        "conflict_ids": ["018f0000-0000-7000-8000-000000000055"],
        "graph_diagnostics": [
            {"class": "cycle", "ids": ["018f0000-0000-7000-8000-000000000051", "018f0000-0000-7000-8000-000000000052"]},
            {"class": "dangling", "from": "018f0000-0000-7000-8000-000000000054", "missing": "018f0000-0000-7000-8000-00000000ffff"},
            {"class": "unavailable-due-to-conflict", "from": "018f0000-0000-7000-8000-000000000056", "id": "018f0000-0000-7000-8000-000000000055"},
        ],
        "views": {
            "downset:018f0000-0000-7000-8000-000000000053": {
                "ids": ["018f0000-0000-7000-8000-000000000051", "018f0000-0000-7000-8000-000000000052", "018f0000-0000-7000-8000-000000000053"],
                "partial": True,
                "obstacles": [{"class": "cycle", "ids": ["018f0000-0000-7000-8000-000000000051", "018f0000-0000-7000-8000-000000000052"]}],
            },
            "downset:018f0000-0000-7000-8000-000000000054": {
                "ids": ["018f0000-0000-7000-8000-000000000054"],
                "partial": True,
                "obstacles": [{"class": "dangling", "missing": "018f0000-0000-7000-8000-00000000ffff"}],
            },
            "downset:018f0000-0000-7000-8000-000000000056": {
                "ids": ["018f0000-0000-7000-8000-000000000056"],
                "partial": True,
                "obstacles": [{"class": "unavailable-due-to-conflict", "id": "018f0000-0000-7000-8000-000000000055"}],
            },
        },
    })

    # 07: critical suppression, per target and author-name intersection.
    t_actor = line("018f0000-0000-7000-8000-000000000061", author={"actor": "alice"}, payload={"text": "alice actor target"})
    t_operator = line("018f0000-0000-7000-8000-000000000062", author={"actor": "model-x", "operator": "alice"}, payload={"text": "operator target"})
    t_import = line("018f0000-0000-7000-8000-000000000063", author={"actor": "unknown", "imported_by": "alice"}, payload={"text": "imported target"})
    t_bob = line("018f0000-0000-7000-8000-000000000064", author={"actor": "bob"}, payload={"text": "bob target"})
    t_empty = line("018f0000-0000-7000-8000-000000000065", author={"actor": "charlie", "operator": ""}, payload={"text": "empty operator target"})
    crit = line("018f0000-0000-7000-8000-000000000066", kind="future/embargo", author={"actor": "alice"}, parents=[
        "018f0000-0000-7000-8000-000000000061",
        "018f0000-0000-7000-8000-000000000062",
        "018f0000-0000-7000-8000-000000000063",
        "018f0000-0000-7000-8000-000000000064",
        "018f0000-0000-7000-8000-00000000aaaa",
    ], payload={"reason": "unknown critical kind"}, critical=True)
    crit_spoof = line("018f0000-0000-7000-8000-000000000067", kind="future/embargo", author={"actor": "mallory"}, parents=["018f0000-0000-7000-8000-000000000061"], payload={"reason": "spoof-shaped negative"}, critical=True)
    crit_empty = line("018f0000-0000-7000-8000-000000000068", kind="future/embargo", author={"actor": "mallory", "operator": ""}, parents=["018f0000-0000-7000-8000-000000000065"], payload={"reason": "empty string must be dropped"}, critical=True)
    damaged_crit = spliced(line("018f0000-0000-7000-8000-000000000069", kind="future/embargo", author={"actor": "bob"}, parents=["018f0000-0000-7000-8000-000000000064"], payload={}, critical=True), override_digest="d" * 64)
    write_fixture("07-critical-suppression", [("input.lore", [spliced(t_actor), spliced(t_operator), spliced(t_import), spliced(t_bob), spliced(t_empty), spliced(crit), spliced(crit_spoof), spliced(crit_empty), damaged_crit], True)], {
        "fixture": "07-critical-suppression",
        "inputs": ["input.lore"],
        "reader_assumption": "ignorant of future/embargo",
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000061"},
            {"file": "input.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000062"},
            {"file": "input.lore", "line": 3, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000063"},
            {"file": "input.lore", "line": 4, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000064"},
            {"file": "input.lore", "line": 5, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000065"},
            {"file": "input.lore", "line": 6, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000066"},
            {"file": "input.lore", "line": 7, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000067"},
            {"file": "input.lore", "line": 8, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000068"},
            {"file": "input.lore", "line": 9, "class": "damaged", "reason": "critical damaged line suppresses nothing"},
        ],
        "suppression": {
            "suppressed_payload_ids": [
                "018f0000-0000-7000-8000-000000000061",
                "018f0000-0000-7000-8000-000000000062",
                "018f0000-0000-7000-8000-000000000063",
            ],
            "not_suppressed_ids": [
                "018f0000-0000-7000-8000-000000000064",
                "018f0000-0000-7000-8000-000000000065",
                "018f0000-0000-7000-8000-000000000066",
                "018f0000-0000-7000-8000-000000000067",
                "018f0000-0000-7000-8000-000000000068",
            ],
            "dangling_target_no_effect_until_union": ["018f0000-0000-7000-8000-00000000aaaa"],
        },
        "view_eligible_ids": [
            "018f0000-0000-7000-8000-000000000061",
            "018f0000-0000-7000-8000-000000000062",
            "018f0000-0000-7000-8000-000000000063",
            "018f0000-0000-7000-8000-000000000064",
            "018f0000-0000-7000-8000-000000000065",
            "018f0000-0000-7000-8000-000000000066",
            "018f0000-0000-7000-8000-000000000067",
            "018f0000-0000-7000-8000-000000000068",
        ],
    })

    # 08: decoded string values win over spelling for id, kind, author matching, duplicate names.
    escaped_id = '{"v":1,"id":"spell-\\u0061","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"\\u0061lice"},"parents":[],"payload":{"text":"escaped id and actor"}}'
    plain_same_id = '{"v":1,"id":"spell-a","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"alice"},"parents":[],"payload":{"text":"same decoded id, different body"}}'
    escaped_kind = '{"v":1,"id":"018f0000-0000-7000-8000-000000000071","kind":"lore\\u002fartifact","at":"2026-07-06T04:10:00Z","author":{"actor":"bob"},"parents":["spell-a"],"payload":{}}'
    dup_escaped_keys = '{"v":1,"id":"018f0000-0000-7000-8000-000000000072","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"bob"},"parents":[],"payload":{"a":1,"\\u0061":2}}'
    target_spelled = '{"v":1,"id":"018f0000-0000-7000-8000-000000000073","kind":"lore/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"\\u0061lice"},"parents":[],"payload":{"text":"suppression target"}}'
    suppress_plain = '{"v":1,"id":"018f0000-0000-7000-8000-000000000074","kind":"future/embargo","at":"2026-07-06T04:10:00Z","author":{"actor":"alice"},"parents":["018f0000-0000-7000-8000-000000000073"],"payload":{},"critical":true}'
    write_fixture("08-spelling-vs-value", [("input.lore", [spliced(escaped_id), spliced(plain_same_id), spliced(escaped_kind), dup_escaped_keys, spliced(target_spelled), spliced(suppress_plain)], True)], {
        "fixture": "08-spelling-vs-value",
        "inputs": ["input.lore"],
        "reader_assumption": "ignorant of future/embargo",
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "conflict-variant", "id": "spell-a", "reason": "decoded id equals line 2, body differs"},
            {"file": "input.lore", "line": 2, "class": "conflict-variant", "id": "spell-a", "reason": "decoded id equals line 1, body differs"},
            {"file": "input.lore", "line": 3, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000071", "reason": "decoded kind contains slash"},
            {"file": "input.lore", "line": 4, "class": "garbage", "reason": "duplicate decoded member name in payload"},
            {"file": "input.lore", "line": 5, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000073"},
            {"file": "input.lore", "line": 6, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000074"},
        ],
        "union_event_ids": ["018f0000-0000-7000-8000-000000000071", "018f0000-0000-7000-8000-000000000073", "018f0000-0000-7000-8000-000000000074"],
        "conflict_ids": ["spell-a"],
        "suppression": {
            "suppressed_payload_ids": ["018f0000-0000-7000-8000-000000000073"],
            "reason": "author actor values intersect after JSON string decoding",
        },
        "views": {
            "downset:018f0000-0000-7000-8000-000000000071": {
                "ids": ["018f0000-0000-7000-8000-000000000071"],
                "partial": True,
                "obstacles": [{"class": "unavailable-due-to-conflict", "id": "spell-a"}],
            }
        },
    })

    # 09: marked/at semantics and timestamp validation.
    marked_ok = line("018f0000-0000-7000-8000-000000000081", at="2026-07-06T04:10:00-07:00", marked="2026-07-07T01:02:03.123456Z", payload={"text": "imported later"})
    leap = line("018f0000-0000-7000-8000-000000000082", at="2026-12-31T23:59:60Z", payload={"text": "RFC3339 leap second ABNF"})
    bad_at = line("018f0000-0000-7000-8000-000000000083", at="2026-07-06 04:10:00Z", payload={"text": "space not T"})
    bad_marked = line("018f0000-0000-7000-8000-000000000084", marked="not-a-time", payload={"text": "bad marked"})
    write_fixture("09-marked-at-semantics", [("input.lore", [spliced(marked_ok), spliced(leap), spliced(bad_at), spliced(bad_marked)], True)], {
        "fixture": "09-marked-at-semantics",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000081", "marked_effective": "2026-07-07T01:02:03.123456Z"},
            {"file": "input.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000082"},
            {"file": "input.lore", "line": 3, "class": "garbage", "reason": "at fails RFC3339 ABNF"},
            {"file": "input.lore", "line": 4, "class": "garbage", "reason": "marked fails RFC3339 ABNF"},
        ],
        "union_event_ids": ["018f0000-0000-7000-8000-000000000081", "018f0000-0000-7000-8000-000000000082"],
        "view_eligible_ids": ["018f0000-0000-7000-8000-000000000081", "018f0000-0000-7000-8000-000000000082"],
    })

    # 10: merge is union across files.
    m1 = line("018f0000-0000-7000-8000-000000000091", payload={"text": "root"})
    m2 = line("018f0000-0000-7000-8000-000000000092", parents=["018f0000-0000-7000-8000-000000000091"], payload={"text": "from A"})
    m3 = line("018f0000-0000-7000-8000-000000000093", parents=["018f0000-0000-7000-8000-000000000092"], payload={"text": "from B completes context"})
    m_conf_a = line("018f0000-0000-7000-8000-000000000094", payload={"text": "merge conflict A"})
    m_conf_b = line("018f0000-0000-7000-8000-000000000094", payload={"text": "merge conflict B"})
    write_fixture("10-merge-union", [
        ("a.lore", [spliced(m1), spliced(m2), spliced(m_conf_a)], True),
        ("b.lore", [spliced(m2), spliced(m3), spliced(m_conf_b)], True),
    ], {
        "fixture": "10-merge-union",
        "inputs": ["a.lore", "b.lore"],
        "line_classifications": [
            {"file": "a.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000091"},
            {"file": "a.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000092"},
            {"file": "a.lore", "line": 3, "class": "conflict-variant", "id": "018f0000-0000-7000-8000-000000000094"},
            {"file": "b.lore", "line": 1, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000092", "duplicate_sighting": True},
            {"file": "b.lore", "line": 2, "class": "accepted", "id": "018f0000-0000-7000-8000-000000000093"},
            {"file": "b.lore", "line": 3, "class": "conflict-variant", "id": "018f0000-0000-7000-8000-000000000094"},
        ],
        "union_event_ids": [
            "018f0000-0000-7000-8000-000000000091",
            "018f0000-0000-7000-8000-000000000092",
            "018f0000-0000-7000-8000-000000000093",
        ],
        "conflict_ids": ["018f0000-0000-7000-8000-000000000094"],
        "views": {
            "downset:018f0000-0000-7000-8000-000000000093": {
                "ids": [
                    "018f0000-0000-7000-8000-000000000091",
                    "018f0000-0000-7000-8000-000000000092",
                    "018f0000-0000-7000-8000-000000000093",
                ],
                "partial": False,
                "obstacles": [],
            }
        },
    })

    # 11: unknown top-level and author fields are nonconforming but carried.
    unknown_top = line("018f0000-0000-7000-8000-000000000101", payload={"text": "unknown top"}, mood="future")
    unknown_author = line("018f0000-0000-7000-8000-000000000102", author={"actor": "deepfates", "role": "extra"}, payload={"text": "unknown author"})
    write_fixture("11-nonconforming-carried", [("input.lore", [spliced(unknown_top), spliced(unknown_author)], True)], {
        "fixture": "11-nonconforming-carried",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "nonconforming", "id": "018f0000-0000-7000-8000-000000000101", "reason": "unknown top-level field carried and surfaced"},
            {"file": "input.lore", "line": 2, "class": "nonconforming", "id": "018f0000-0000-7000-8000-000000000102", "reason": "unknown author field carried and surfaced"},
        ],
        "union_event_ids": ["018f0000-0000-7000-8000-000000000101", "018f0000-0000-7000-8000-000000000102"],
        "view_eligible_ids": ["018f0000-0000-7000-8000-000000000101", "018f0000-0000-7000-8000-000000000102"],
    })

    # 12: invalid sig splice grammar means no splice; body parse then finds reserved names.
    invalid_sig = line("018f0000-0000-7000-8000-000000000111", payload={"text": "invalid sig grammar"})
    invalid_sig = invalid_sig[:-1] + ',"digest":"sha256:' + digest(invalid_sig) + '","sig":"abc-_"}'
    write_fixture("12-invalid-sig-splice", [("input.lore", [invalid_sig], True)], {
        "fixture": "12-invalid-sig-splice",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "garbage", "reason": "invalid sig grammar means no splice; reserved top-level digest/sig remain in body"},
        ],
        "union_event_ids": [],
        "view_eligible_ids": [],
    })

    # 13: sig metadata requires digest metadata, so sig alone is body and reserved-name garbage.
    sig_without_digest = line("018f0000-0000-7000-8000-000000000121", payload={"text": "sig without digest"})
    sig_without_digest = sig_without_digest[:-1] + ',"sig":"QUJDRA=="}'
    write_fixture("13-sig-without-digest", [("input.lore", [sig_without_digest], True)], {
        "fixture": "13-sig-without-digest",
        "inputs": ["input.lore"],
        "line_classifications": [
            {"file": "input.lore", "line": 1, "class": "garbage", "reason": "sig without digest is not a valid splice; reserved top-level sig remains in body"},
        ],
        "union_event_ids": [],
        "view_eligible_ids": [],
    })


if __name__ == "__main__":
    main()
