---
id: lyn-6lzi
status: open
deps: []
links: []
created: 2026-08-01T13:07:14Z
type: feature
priority: 1
assignee: deepfates
tags: [parser, scale, browser, behold, textile]
---
# Index large Lync unions from re-readable streaming sources

Add the smallest browser-safe Lync seam that preserves canonical union semantics while avoiding retention of every physical source line and parsed payload. This is required by Behold multi-day resident histories and Textile's ordinary local reader; current parseLyncFiles/LyncUnion necessarily retain the complete corpus, so a Textile worker or chunk wrapper would only move the same materialization.

## Design

Consume ordered re-readable async byte sources. Frame and authenticate lines incrementally, retaining compact source/offset/line locators plus envelope topology, classification, digests, richness, conflicts, pending parents, graph obstacles, and critical suppression. Re-read exact body bytes lazily only when duplicate-ID adjudication requires them; expose an async iterator that parses one held view-eligible event at a time and a lazy exact-line read for source-preserving export. Keep existing eager parser APIs unchanged. Do not implement Lync union semantics independently in Textile.

## Acceptance Criteria

All v0 conformance vectors and existing eager parser tests produce the same accepted/nonconforming/garbage/damaged/conflict classes, union ids, pending parents, graph diagnostics, richness selection, and critical suppression through the indexed path. Eager-versus-indexed equality holds for representative multi-source Behold histories, including duplicate ids and source-order changes. A representative retained six-hour two-resident source set can be scanned and presented with raw working memory bounded by declared chunk size plus largest admitted line, no retained corpus-sized Uint8Array/string or parsed payload graph, and instrumentation proving payload-byte growth does not determine retained heap. Exact carried/source lines remain lazily readable by locator; damaged/truncated/reordered sources fail closed; browser and Node builds pass; no publication.

