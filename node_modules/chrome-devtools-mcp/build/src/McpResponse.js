import { formatConsoleEvent } from './formatters/consoleFormatter.js';
import { getFormattedHeaderValue, getShortDescriptionForRequest, getStatusFromRequest, } from './formatters/networkFormatter.js';
import { formatA11ySnapshot } from './formatters/snapshotFormatter.js';
import { handleDialog } from './tools/pages.js';
import { paginate } from './utils/pagination.js';
export class McpResponse {
    #includePages = false;
    #includeSnapshot = false;
    #attachedNetworkRequestUrl;
    #includeConsoleData = false;
    #textResponseLines = [];
    #formattedConsoleData;
    #images = [];
    #networkRequestsOptions;
    setIncludePages(value) {
        this.#includePages = value;
    }
    setIncludeSnapshot(value) {
        this.#includeSnapshot = value;
    }
    setIncludeNetworkRequests(value, options) {
        if (!value) {
            this.#networkRequestsOptions = undefined;
            return;
        }
        this.#networkRequestsOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            resourceTypes: options?.resourceTypes,
        };
    }
    setIncludeConsoleData(value) {
        this.#includeConsoleData = value;
    }
    attachNetworkRequest(url) {
        this.#attachedNetworkRequestUrl = url;
    }
    get includePages() {
        return this.#includePages;
    }
    get includeNetworkRequests() {
        return this.#networkRequestsOptions?.include ?? false;
    }
    get includeConsoleData() {
        return this.#includeConsoleData;
    }
    get attachedNetworkRequestUrl() {
        return this.#attachedNetworkRequestUrl;
    }
    get networkRequestsPageIdx() {
        return this.#networkRequestsOptions?.pagination?.pageIdx;
    }
    appendResponseLine(value) {
        this.#textResponseLines.push(value);
    }
    attachImage(value) {
        this.#images.push(value);
    }
    get responseLines() {
        return this.#textResponseLines;
    }
    get images() {
        return this.#images;
    }
    get includeSnapshot() {
        return this.#includeSnapshot;
    }
    async handle(toolName, context) {
        if (this.#includePages) {
            await context.createPagesSnapshot();
        }
        if (this.#includeSnapshot) {
            await context.createTextSnapshot();
        }
        let formattedConsoleMessages;
        if (this.#includeConsoleData) {
            const consoleMessages = context.getConsoleData();
            if (consoleMessages) {
                formattedConsoleMessages = await Promise.all(consoleMessages.map(message => formatConsoleEvent(message)));
                this.#formattedConsoleData = formattedConsoleMessages;
            }
        }
        return this.format(toolName, context);
    }
    format(toolName, context) {
        const response = [`# ${toolName} response`];
        for (const line of this.#textResponseLines) {
            response.push(line);
        }
        const networkConditions = context.getNetworkConditions();
        if (networkConditions) {
            response.push(`## Network emulation`);
            response.push(`Emulating: ${networkConditions}`);
            response.push(`Default navigation timeout set to ${context.getNavigationTimeout()} ms`);
        }
        const cpuThrottlingRate = context.getCpuThrottlingRate();
        if (cpuThrottlingRate > 1) {
            response.push(`## CPU emulation`);
            response.push(`Emulating: ${cpuThrottlingRate}x slowdown`);
        }
        const dialog = context.getDialog();
        if (dialog) {
            response.push(`# Open dialog
${dialog.type()}: ${dialog.message()} (default value: ${dialog.message()}).
Call ${handleDialog.name} to handle it before continuing.`);
        }
        if (this.#includePages) {
            const parts = [`## Pages`];
            let idx = 0;
            for (const page of context.getPages()) {
                parts.push(`${idx}: ${page.url()}${idx === context.getSelectedPageIdx() ? ' [selected]' : ''}`);
                idx++;
            }
            response.push(...parts);
        }
        if (this.#includeSnapshot) {
            const snapshot = context.getTextSnapshot();
            if (snapshot) {
                const formattedSnapshot = formatA11ySnapshot(snapshot.root);
                response.push('## Page content');
                response.push(formattedSnapshot);
            }
        }
        response.push(...this.#getIncludeNetworkRequestsData(context));
        if (this.#networkRequestsOptions?.include) {
            let requests = context.getNetworkRequests();
            // Apply resource type filtering if specified
            if (this.#networkRequestsOptions.resourceTypes?.length) {
                const normalizedTypes = new Set(this.#networkRequestsOptions.resourceTypes);
                requests = requests.filter(request => {
                    const type = request.resourceType();
                    return normalizedTypes.has(type);
                });
            }
            response.push('## Network requests');
            if (requests.length) {
                const data = this.#dataWithPagination(requests, this.#networkRequestsOptions.pagination);
                response.push(...data.info);
                for (const request of data.items) {
                    response.push(getShortDescriptionForRequest(request));
                }
            }
            else {
                response.push('No requests found.');
            }
        }
        if (this.#includeConsoleData && this.#formattedConsoleData) {
            response.push('## Console messages');
            if (this.#formattedConsoleData.length) {
                response.push(...this.#formattedConsoleData);
            }
            else {
                response.push('<no console messages found>');
            }
        }
        const text = {
            type: 'text',
            text: response.join('\n'),
        };
        const images = this.#images.map(imageData => {
            return {
                type: 'image',
                ...imageData,
            };
        });
        return [text, ...images];
    }
    #dataWithPagination(data, pagination) {
        const response = [];
        const paginationResult = paginate(data, pagination);
        if (paginationResult.invalidPage) {
            response.push('Invalid page number provided. Showing first page.');
        }
        const { startIndex, endIndex, currentPage, totalPages } = paginationResult;
        response.push(`Showing ${startIndex + 1}-${endIndex} of ${data.length} (Page ${currentPage + 1} of ${totalPages}).`);
        if (pagination) {
            if (paginationResult.hasNextPage) {
                response.push(`Next page: ${currentPage + 1}`);
            }
            if (paginationResult.hasPreviousPage) {
                response.push(`Previous page: ${currentPage - 1}`);
            }
        }
        return {
            info: response,
            items: paginationResult.items,
        };
    }
    #getIncludeNetworkRequestsData(context) {
        const response = [];
        const url = this.#attachedNetworkRequestUrl;
        if (!url) {
            return response;
        }
        const httpRequest = context.getNetworkRequestByUrl(url);
        response.push(`## Request ${httpRequest.url()}`);
        response.push(`Status:  ${getStatusFromRequest(httpRequest)}`);
        response.push(`### Request Headers`);
        for (const line of getFormattedHeaderValue(httpRequest.headers())) {
            response.push(line);
        }
        const httpResponse = httpRequest.response();
        if (httpResponse) {
            response.push(`### Response Headers`);
            for (const line of getFormattedHeaderValue(httpResponse.headers())) {
                response.push(line);
            }
        }
        const httpFailure = httpRequest.failure();
        if (httpFailure) {
            response.push(`### Request failed with`);
            response.push(httpFailure.errorText);
        }
        const redirectChain = httpRequest.redirectChain();
        if (redirectChain.length) {
            response.push(`### Redirect chain`);
            let indent = 0;
            for (const request of redirectChain.reverse()) {
                response.push(`${'  '.repeat(indent)}${getShortDescriptionForRequest(request)}`);
                indent++;
            }
        }
        return response;
    }
    resetResponseLineForTesting() {
        this.#textResponseLines = [];
    }
}
