import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';

export class NotFoundError extends Error {}

export class ConflictError extends Error {}

export class InvalidCursorError extends Error {}

function parserErrorType(err: unknown): string | undefined {
    if (err instanceof Error && 'type' in err && typeof err.type === 'string') {
        return err.type;
    }
    return undefined;
}

function send(res: Response, status: number, code: string, message: string, details?: unknown): void {
    res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof ZodError) {
        send(res, 400, 'invalid_request', 'Request body failed validation.', err.issues);
        return;
    }

    const parserType = parserErrorType(err);
    if (parserType === 'entity.parse.failed') {
        send(res, 400, 'invalid_json', 'Request body is not valid JSON.');
        return;
    }
    if (parserType === 'entity.too.large') {
        send(res, 413, 'payload_too_large', 'Request body is too large.');
        return;
    }

    if (err instanceof InvalidCursorError) {
        send(res, 400, 'invalid_cursor', err.message);
        return;
    }
    if (err instanceof NotFoundError) {
        send(res, 404, 'not_found', err.message);
        return;
    }
    if (err instanceof ConflictError) {
        send(res, 409, 'conflict', err.message);
        return;
    }

    logger.error({ err }, 'unhandled error');
    send(res, 500, 'internal_error', 'Something went wrong.');
}
