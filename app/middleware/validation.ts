import { NextResponse } from 'next/server';
import { z } from 'zod';

// User generations query schema
export const getGenerationsQuerySchema = z.object({
  limit: z.string().transform(val => Math.min(parseInt(val) || 50, 100)).optional(),
  offset: z.string().transform(val => Math.max(parseInt(val) || 0, 0)).optional(),
});

/**
 * Validates query parameters against a Zod schema
 */
export function validateQuery<T>(schema: z.ZodSchema<T>, searchParams: URLSearchParams): {
  success: true;
  data: T;
} | {
  success: false;
  errors: z.ZodIssue[];
} {
  const queryData: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    queryData[key] = value;
  }

  const result = schema.safeParse(queryData);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, errors: result.error.issues };
  }
}

/**
 * Creates a standardized error response
 */
export function createErrorResponse(
  message: string,
  status: number = 400,
  details?: any
): NextResponse {
  const errorResponse = {
    error: message,
    ...(details && { details }),
    timestamp: new Date().toISOString()
  };

  return NextResponse.json(errorResponse, { status });
}

/**
 * Creates a standardized success response
 */
export function createSuccessResponse(
  data: any,
  status: number = 200
): NextResponse {
  return NextResponse.json(data, { status });
}
