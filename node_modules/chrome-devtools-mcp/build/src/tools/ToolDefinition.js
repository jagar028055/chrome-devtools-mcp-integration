/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import z from 'zod';
export function defineTool(definition) {
    return definition;
}
export const CLOSE_PAGE_ERROR = 'The last open page cannot be closed. It is fine to keep it open.';
export const timeoutSchema = {
    timeout: z
        .number()
        .int()
        .optional()
        .describe(`Maximum wait time in milliseconds. If set to 0, the default timeout will be used.`)
        .transform(value => {
        return value && value <= 0 ? undefined : value;
    }),
};
