/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export class PageCollector {
    #browser;
    #initializer;
    /**
     * The Array in this map should only be set once
     * As we use the reference to it.
     * Use methods that manipulate the array in place.
     */
    storage = new WeakMap();
    constructor(browser, initializer) {
        this.#browser = browser;
        this.#initializer = initializer;
    }
    async init() {
        const pages = await this.#browser.pages();
        for (const page of pages) {
            this.#initializePage(page);
        }
        this.#browser.on('targetcreated', async (target) => {
            const page = await target.page();
            if (!page) {
                return;
            }
            this.#initializePage(page);
        });
    }
    addPage(page) {
        this.#initializePage(page);
    }
    #initializePage(page) {
        if (this.storage.has(page)) {
            return;
        }
        const stored = [];
        this.storage.set(page, stored);
        page.on('framenavigated', frame => {
            // Only reset the storage on main frame navigation
            if (frame !== page.mainFrame()) {
                return;
            }
            this.cleanup(page);
        });
        this.#initializer(page, value => {
            stored.push(value);
        });
    }
    cleanup(page) {
        const collection = this.storage.get(page);
        if (collection) {
            // Keep the reference alive
            collection.length = 0;
        }
    }
    getData(page) {
        return this.storage.get(page) ?? [];
    }
}
export class NetworkCollector extends PageCollector {
    cleanup(page) {
        const requests = this.storage.get(page) ?? [];
        if (!requests) {
            return;
        }
        const lastRequestIdx = requests.findLastIndex(request => {
            return request.frame() === page.mainFrame()
                ? request.isNavigationRequest()
                : false;
        });
        // Keep all requests since the last navigation request including that
        // navigation request itself.
        // Keep the reference
        requests.splice(0, Math.max(lastRequestIdx, 0));
    }
}
