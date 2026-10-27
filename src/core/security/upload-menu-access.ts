export function uploadMenuKeys(purpose: string | null | undefined): string[] {
  if (purpose?.startsWith('member_photo:') || purpose?.startsWith('member_document:')) return ['members', 'construction_funding'];
  const keys: Record<string, string[]> = { institute_document: ["institute_posts", "institute_documents"], payment_proof: ['deposits', 'construction_funding'], expense_doc: ['expenses'], notice_image: ['notices'], fixed_asset_invoice: ['assets'], payroll_receipt: ['payroll_bills'], payroll_leave_note: ['payroll_leave'], construction_site: ['construction_site_log', 'construction_control', 'construction_contractors', 'construction_running_bills'] };
  return keys[purpose ?? ''] ?? [];
}
