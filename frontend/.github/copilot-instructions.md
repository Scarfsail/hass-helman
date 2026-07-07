# Helman Card - AI Coding Agent Instructions

This document provides guidance for AI coding agents working on the `helman-card` codebase.

## Project Overview & Architecture

This project is a Home Assistant Lovelace custom card for visualizing and controlling power-consuming devices. It is built with [Lit](https://lit.dev/) and TypeScript.

- **Entrypoint**: The main card component is `src/helman-card.ts`, which defines the `helman-card` custom element.
- **Data Fetching**: The core logic for fetching data from Home Assistant is in `src/energy-data-helper.ts`. This file is responsible for querying the Home Assistant WebSocket API to get device, entity, and energy preference information.
- **Data Model**: The data is structured as a tree of `DeviceNode` objects, defined in `src/DeviceNode.ts`. Each `DeviceNode` represents a device and its power consumption.
- **Component Structure**: The main card (`helman-card`) renders a list of `power-device` components (`src/power-device.ts`), each representing a single device in the tree.
- **Dependencies**: The card relies on types and interfaces from the `hass-frontend` directory, which is a subset of the official Home Assistant frontend. This provides type safety for objects like `HomeAssistant` and `LovelaceCard`. Do not import any implementations from `hass-frontend`, only types.

## Developer Workflow

The project uses `vite` for building the card.

1.  **Installation**:
    ```bash
    npm install
    ```

2.  **Development Build**: To build the card for development and watch for changes:
    ```bash
    npm run watch
    ```
    This generates `dist/helman-card-dev.js`. You will need to load this file as a resource in your Home Assistant Lovelace configuration to test the card.

3.  **Production Build**: To create a minified production build:
    ```bash
    npm run build-prod
    ```
    This generates `dist/helman-card-prod.js`, which is the distributable version of the card.

## Key Conventions & Patterns

- **Home Assistant Integration**: All interactions with Home Assistant are done through the `HomeAssistant` object (`this._hass`). Data is fetched via `hass.connection.sendMessagePromise`.
- **Data Aggregation**: The `fetchDeviceTree` function in `src/energy-data-helper.ts` is critical. It aggregates data from multiple sources within Home Assistant (energy preferences, device registry, entity registry) to build the device hierarchy.
- **Entity Disambiguation**: A single device can have multiple entities. The card configuration allows specifying `power_sensor_label` and `power_switch_label` to select the correct entities based on Home Assistant Labels. This is a key pattern for handling complex device setups.
- **State Management**: The card's state is managed within the Lit components using the `@state()` decorator. The main `helman-card` component holds the `_deviceTree` in its state.
- **Styling**: Styles are encapsulated within the Lit components using the `static get styles()` getter.

When making changes, ensure you understand the data flow from Home Assistant's backend, through the `energy-data-helper.ts`, into the `DeviceNode` model, and finally to the rendering logic in the Lit components.

Also keep the files reasonably small and focused. Each component should ideally handle a single responsibility, such as rendering a device or fetching data.
