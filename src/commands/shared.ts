import { SubjectError, parseSubject, type Subject } from '../subject.js';
import { UsageError } from '../output.js';

/** Parse a subject argument, reporting bad input as a usage error. */
export function parseSubjectArg(input: string): Subject {
  try {
    return parseSubject(input);
  } catch (error) {
    if (error instanceof SubjectError) throw new UsageError(error.message);
    throw error;
  }
}
