import { InlineLabelCollisionError } from "../layout/inline-label-error.js";

/** Raised after normal caption recovery when a wire caption cannot be associated
 * with its conductor or its plate cannot preserve visible conductor approaches. */
export class CircuitCaptionCollisionError extends InlineLabelCollisionError {}
