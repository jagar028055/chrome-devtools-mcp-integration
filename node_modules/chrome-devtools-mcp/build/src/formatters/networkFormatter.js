/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export function getShortDescriptionForRequest(request) {
    return `${request.url()} ${request.method()} ${getStatusFromRequest(request)}`;
}
export function getStatusFromRequest(request) {
    const httpResponse = request.response();
    const failure = request.failure();
    let status;
    if (httpResponse) {
        const responseStatus = httpResponse.status();
        status =
            responseStatus >= 200 && responseStatus <= 299
                ? `[success - ${responseStatus}]`
                : `[failed - ${responseStatus}]`;
    }
    else if (failure) {
        status = `[failed - ${failure.errorText}]`;
    }
    else {
        status = '[pending]';
    }
    return status;
}
export function getFormattedHeaderValue(headers) {
    const response = [];
    for (const [name, value] of Object.entries(headers)) {
        response.push(`- ${name}:${value}`);
    }
    return response;
}
