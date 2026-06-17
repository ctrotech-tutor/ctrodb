# CtroDB v3 — Rebuild Plans

This directory contains the complete planning documents for rebuilding ctrodb from the ground up.

## Overview

CtroDB is a **zero-dependency, reactive, client-side database** built on top of IndexedDB with a modern ORM-like API. v3 is a complete ground-up rewrite focused on developer experience, type safety, performance, and reliability.

## Core Philosophy

> "CtroDB is the Prisma of client-side databases — schema-driven, type-safe, reactive, and a joy to use."

## Plans Index

| # | Document | Description |
|---|---|---|
| 00 | [Vision & Positioning](00-vision-and-positioning.md) | Why ctrodb exists, competitive analysis, target audience |
| 01 | [Architecture](01-architecture.md) | System design, module structure, data flow |
| 02 | [API Design](02-api-design.md) | Complete public API surface |
| 03 | [Data Model & Schema](03-data-model-and-schema.md) | Schema definition, validation, types |
| 04 | [Query Engine](04-query-engine.md) | Query builder, planner, executor, optimization |
| 05 | [Reactivity System](05-reactivity-system.md) | Signals, observers, change tracking, framework integration |
| 06 | [Storage Adapters](06-storage-adapters.md) | IndexedDB, Memory, Node.js adapters |
| 07 | [Plugins](07-plugins.md) | FTS, Relations, Validation, Encryption |
| 08 | [Framework Bindings](08-framework-bindings.md) | React, CDN/UMD for junior devs |
| 09 | [Testing Strategy](09-testing-strategy.md) | Unit, integration, benchmark, stress testing |
| 10 | [Workspace Setup](10-workspace-setup.md) | Repo cleanup, tooling, build, CI/CD |
| 11 | [Roadmap](11-roadmap.md) | Release phases, milestones, timeline |

## Key Principles

- **Zero runtime dependencies** — Core + plugins are 100% self-written
- **TypeScript strict** — End-to-end type safety with full generics
- **CDN first-class** — Junior devs can use it via `<script>` tag with zero setup
- **Tree-shakeable** — Bundler users only pay for what they import
- **Framework-agnostic core** — React/Vue/Svelte/Solid bindings are separate
- **Developer experience above all** — Helpful errors, console-friendly, intuitive API
