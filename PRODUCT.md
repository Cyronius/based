# Based

<!-- impeccable:product-schema 1 -->

## Platform

web

This record describes the GitHub Pages marketing surface for the Based desktop application.

## Users

Developers and people working with databases who need to query, inspect, and explore SQL Server, Snowflake, and LanceDB. The user confirmed that the site should lead with the full database workbench, giving all three engines a place in the story.

## Product Purpose

Based is a local desktop database client with an AI agent participating in the same workspace. The marketing site helps visitors understand the workbench and find the application downloads and documentation.

## Positioning

The agent can read open tabs, open query tabs, and put results in sortable, exportable grids. Proposed database changes require explicit user approval. The workspace is the product's central mechanism.

## Capabilities and Constraints

- SQL Server, Snowflake, and LanceDB, as documented in README.md.
- SQL editing, data grids, schema inspection, query execution, and connection-aware agent tools.
- LanceDB vector, keyword, and hybrid search, plus an Embeddings Atlas.
- Local or hosted models through user-configured profiles; the desktop application does not bundle a model.
- Windows downloads; experimental Apple Silicon macOS support; Linux is in progress, per the repository documentation.
- The user explicitly authorized implementing the selected design and publishing it as the repository's GitHub Pages site at https://cyronius.github.io/based/. The marketing site is a buildless static page under site/. It contains an illustrative browser-local workbench demo; the desktop application remains separate.

## Brand Commitments

Preserve the name `based`. The user selected the Mint Tabscape concept, requesting the actual Capi capybara from a product screenshot in place of its generic robot mascots. Capi is the tan illustrated capybara visible in docs/screenshots/hero.png. The approved visual reference is .impeccable/mocks/decision/10-mint-tabscape-capi-v2.png. The user then instructed implementation and GitHub Pages publication of that design.

## Evidence on Hand

README.md contains the product narrative and installation instructions. docs/screenshots contains workspace, agent, approval, search, schema, plan, theme, and Atlas demonstrations. assets/icon-source.png is the existing app icon master. Do not invent customer counts, testimonials, benchmarks, prices, or additional engine support.

## Open Decisions

The selected direction is implemented with responsive behavior and functional illustrative controls. Desktop platform status and download assets were checked against the repository and release v0.1.6 during publication preparation. Download links use the latest public release API with a latest-release page fallback.
