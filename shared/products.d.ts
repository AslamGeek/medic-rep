import type { Product } from '../src/types'

export function resolveProductReference(reference: string, products: Product[]): string
export function productReferences(value: unknown, products: Product[]): string[]
export function productIdsFromCell(value: unknown, products: Product[]): string[]
export function unresolvedProductReferences(references: unknown, products: Product[]): string[]
