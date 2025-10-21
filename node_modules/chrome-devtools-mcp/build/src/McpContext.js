/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetworkCollector, PageCollector } from './PageCollector.js';
import { listPages } from './tools/pages.js';
import { takeSnapshot } from './tools/snapshot.js';
import { CLOSE_PAGE_ERROR } from './tools/ToolDefinition.js';
import { WaitForHelper } from './WaitForHelper.js';
const DEFAULT_TIMEOUT = 5_000;
const NAVIGATION_TIMEOUT = 10_000;
function getNetworkMultiplierFromString(condition) {
    const puppeteerCondition = condition;
    switch (puppeteerCondition) {
        case 'Fast 4G':
            return 1;
        case 'Slow 4G':
            return 2.5;
        case 'Fast 3G':
            return 5;
        case 'Slow 3G':
            return 10;
    }
    return 1;
}
function getExtensionFromMimeType(mimeType) {
    switch (mimeType) {
        case 'image/png':
            return 'png';
        case 'image/jpeg':
            return 'jpeg';
        case 'image/webp':
            return 'webp';
    }
    throw new Error(`No mapping for Mime type ${mimeType}.`);
}
export class McpContext {
    browser;
    logger;
    // The most recent page state.
    #pages = [];
    #selectedPageIdx = 0;
    // The most recent snapshot.
    #textSnapshot = null;
    #networkCollector;
    #consoleCollector;
    #isRunningTrace = false;
    #networkConditionsMap = new WeakMap();
    #cpuThrottlingRateMap = new WeakMap();
    #dialog;
    #nextSnapshotId = 1;
    #traceResults = [];
    constructor(browser, logger) {
        this.browser = browser;
        this.logger = logger;
        this.#networkCollector = new NetworkCollector(this.browser, (page, collect) => {
            page.on('request', request => {
                collect(request);
            });
        });
        this.#consoleCollector = new PageCollector(this.browser, (page, collect) => {
            page.on('console', event => {
                collect(event);
            });
            page.on('pageerror', event => {
                collect(event);
            });
        });
    }
    async #init() {
        await this.createPagesSnapshot();
        this.setSelectedPageIdx(0);
        await this.#networkCollector.init();
        await this.#consoleCollector.init();
    }
    static async from(browser, logger) {
        const context = new McpContext(browser, logger);
        await context.#init();
        return context;
    }
    getNetworkRequests() {
        const page = this.getSelectedPage();
        return this.#networkCollector.getData(page);
    }
    getConsoleData() {
        const page = this.getSelectedPage();
        return this.#consoleCollector.getData(page);
    }
    async newPage() {
        const page = await this.browser.newPage();
        const pages = await this.createPagesSnapshot();
        this.setSelectedPageIdx(pages.indexOf(page));
        this.#networkCollector.addPage(page);
        this.#consoleCollector.addPage(page);
        return page;
    }
    async closePage(pageIdx) {
        if (this.#pages.length === 1) {
            throw new Error(CLOSE_PAGE_ERROR);
        }
        const page = this.getPageByIdx(pageIdx);
        this.setSelectedPageIdx(0);
        await page.close({ runBeforeUnload: false });
    }
    getNetworkRequestByUrl(url) {
        const requests = this.getNetworkRequests();
        if (!requests.length) {
            throw new Error('No requests found for selected page');
        }
        for (const request of requests) {
            if (request.url() === url) {
                return request;
            }
        }
        throw new Error('Request not found for selected page');
    }
    setNetworkConditions(conditions) {
        const page = this.getSelectedPage();
        if (conditions === null) {
            this.#networkConditionsMap.delete(page);
        }
        else {
            this.#networkConditionsMap.set(page, conditions);
        }
        this.#updateSelectedPageTimeouts();
    }
    getNetworkConditions() {
        const page = this.getSelectedPage();
        return this.#networkConditionsMap.get(page) ?? null;
    }
    setCpuThrottlingRate(rate) {
        const page = this.getSelectedPage();
        this.#cpuThrottlingRateMap.set(page, rate);
        this.#updateSelectedPageTimeouts();
    }
    getCpuThrottlingRate() {
        const page = this.getSelectedPage();
        return this.#cpuThrottlingRateMap.get(page) ?? 1;
    }
    setIsRunningPerformanceTrace(x) {
        this.#isRunningTrace = x;
    }
    isRunningPerformanceTrace() {
        return this.#isRunningTrace;
    }
    getDialog() {
        return this.#dialog;
    }
    clearDialog() {
        this.#dialog = undefined;
    }
    getSelectedPage() {
        const page = this.#pages[this.#selectedPageIdx];
        if (!page) {
            throw new Error('No page selected');
        }
        if (page.isClosed()) {
            throw new Error(`The selected page has been closed. Call ${listPages.name} to see open pages.`);
        }
        return page;
    }
    getPageByIdx(idx) {
        const pages = this.#pages;
        const page = pages[idx];
        if (!page) {
            throw new Error('No page found');
        }
        return page;
    }
    getSelectedPageIdx() {
        return this.#selectedPageIdx;
    }
    #dialogHandler = (dialog) => {
        this.#dialog = dialog;
    };
    setSelectedPageIdx(idx) {
        const oldPage = this.getSelectedPage();
        oldPage.off('dialog', this.#dialogHandler);
        this.#selectedPageIdx = idx;
        const newPage = this.getSelectedPage();
        newPage.on('dialog', this.#dialogHandler);
        this.#updateSelectedPageTimeouts();
    }
    #updateSelectedPageTimeouts() {
        const page = this.getSelectedPage();
        // For waiters 5sec timeout should be sufficient.
        // Increased in case we throttle the CPU
        const cpuMultiplier = this.getCpuThrottlingRate();
        page.setDefaultTimeout(DEFAULT_TIMEOUT * cpuMultiplier);
        // 10sec should be enough for the load event to be emitted during
        // navigations.
        // Increased in case we throttle the network requests
        const networkMultiplier = getNetworkMultiplierFromString(this.getNetworkConditions());
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT * networkMultiplier);
    }
    getNavigationTimeout() {
        const page = this.getSelectedPage();
        return page.getDefaultNavigationTimeout();
    }
    async getElementByUid(uid) {
        if (!this.#textSnapshot?.idToNode.size) {
            throw new Error(`No snapshot found. Use ${takeSnapshot.name} to capture one.`);
        }
        const [snapshotId] = uid.split('_');
        if (this.#textSnapshot.snapshotId !== snapshotId) {
            throw new Error('This uid is coming from a stale snapshot. Call take_snapshot to get a fresh snapshot.');
        }
        const node = this.#textSnapshot?.idToNode.get(uid);
        if (!node) {
            throw new Error('No such element found in the snapshot');
        }
        const handle = await node.elementHandle();
        if (!handle) {
            throw new Error('No such element found in the snapshot');
        }
        return handle;
    }
    /**
     * Creates a snapshot of the pages.
     */
    async createPagesSnapshot() {
        this.#pages = await this.browser.pages();
        return this.#pages;
    }
    getPages() {
        return this.#pages;
    }
    /**
     * Creates a text snapshot of a page.
     */
    async createTextSnapshot() {
        const page = this.getSelectedPage();
        const rootNode = await page.accessibility.snapshot({
            includeIframes: true,
        });
        if (!rootNode) {
            return;
        }
        const snapshotId = this.#nextSnapshotId++;
        // Iterate through the whole accessibility node tree and assign node ids that
        // will be used for the tree serialization and mapping ids back to nodes.
        let idCounter = 0;
        const idToNode = new Map();
        const assignIds = (node) => {
            const nodeWithId = {
                ...node,
                id: `${snapshotId}_${idCounter++}`,
                children: node.children
                    ? node.children.map(child => assignIds(child))
                    : [],
            };
            idToNode.set(nodeWithId.id, nodeWithId);
            return nodeWithId;
        };
        const rootNodeWithId = assignIds(rootNode);
        this.#textSnapshot = {
            root: rootNodeWithId,
            snapshotId: String(snapshotId),
            idToNode,
        };
    }
    getTextSnapshot() {
        return this.#textSnapshot;
    }
    async saveTemporaryFile(data, mimeType) {
        try {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-devtools-mcp-'));
            const filename = path.join(dir, `screenshot.${getExtensionFromMimeType(mimeType)}`);
            await fs.writeFile(filename, data);
            return { filename };
        }
        catch (err) {
            this.logger(err);
            throw new Error('Could not save a screenshot to a file', { cause: err });
        }
    }
    async saveFile(data, filename) {
        try {
            const filePath = path.resolve(filename);
            await fs.writeFile(filePath, data);
            return { filename };
        }
        catch (err) {
            this.logger(err);
            throw new Error('Could not save a screenshot to a file', { cause: err });
        }
    }
    storeTraceRecording(result) {
        this.#traceResults.push(result);
    }
    recordedTraces() {
        return this.#traceResults;
    }
    getWaitForHelper(page, cpuMultiplier, networkMultiplier) {
        return new WaitForHelper(page, cpuMultiplier, networkMultiplier);
    }
    waitForEventsAfterAction(action) {
        const page = this.getSelectedPage();
        const cpuMultiplier = this.getCpuThrottlingRate();
        const networkMultiplier = getNetworkMultiplierFromString(this.getNetworkConditions());
        const waitForHelper = this.getWaitForHelper(page, cpuMultiplier, networkMultiplier);
        return waitForHelper.waitForEventsAfterAction(action);
    }
}
