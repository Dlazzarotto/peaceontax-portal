export const INDIVIDUAL_CATEGORIES: Record<string, string[]> = {
  'Income': ['W-2 Wages','1099-NEC / 1099-MISC','1099-INT Interest','1099-DIV Dividends','1099-B Investments','1099-R Retirement','SSA-1099 Social Security','1099-G Unemployment','K-1 Partnership/S-Corp','Other Income'],
  'Deductions': ['1098 Mortgage Interest','Property Tax','Charitable Donations','Medical Expenses','Student Loan Interest','Tuition / 1098-T','Business Expenses (Schedule C)','Home Office','Vehicle / Mileage','Other Deductions'],
  'Health & Benefits': ['Health Insurance (1095-A/B/C)','HSA / FSA','Childcare / Dependent Care'],
  'Retirement': ['IRA Contributions','401k / 403b','Pension'],
  'Real Estate': ['Rental Income','Rental Expenses','Settlement Statement (HUD)','Property Purchase / Sale'],
  'Prior Year Returns': ['Federal Return','State Return','Amended Return','IRS Notices'],
  'Identity & Personal': ['Driver License / ID','Social Security Card','Passport','ITIN Documents','Power of Attorney'],
  'Bank Statements': ['Checking Account','Savings Account','Investment Account'],
  'Correspondence': ['IRS Letters','State Tax Notices','Firm Correspondence'],
  'Signed Documents': ['Engagement Letter','Federal Return (Signed)','State Return (Signed)','8879 E-File Authorization'],
}

export const BUSINESS_CATEGORIES: Record<string, string[]> = {
  'Financial Statements': ['Profit & Loss','Balance Sheet','Cash Flow Statement','General Ledger','Trial Balance'],
  'Bank Statements': ['Checking Account','Savings Account','Credit Card Statements','Merchant Processing','Loan Statements'],
  'Income': ['Sales / Revenue Records','1099s Received','K-1 Received','Other Income'],
  'Payroll': ['Payroll Reports','W-2s Issued','941 Quarterly Returns','940 Annual Return','W-3 Transmittal','State Payroll Returns'],
  'Expenses': ['Receipts & Invoices','Vehicle / Mileage Log','Home Office','Travel & Entertainment','Equipment Purchases','Software & Subscriptions','Insurance','Professional Services','Rent / Lease','Utilities'],
  'Tax Documents': ['1120 / 1120S / 1065 Return','Schedule K-1s Issued','Sales Tax Returns','Property Tax','Estimated Tax Payments','IRS Notices','State Tax Notices'],
  'Corporate Documents': ['Articles of Incorporation','Operating Agreement / Bylaws','EIN Letter','State Registration','Annual Report','Meeting Minutes','Shareholder Agreements'],
  'Accounts Receivable': ['Invoices Issued','Customer Statements','Aging Report'],
  'Accounts Payable': ['Bills / Vendor Invoices','Vendor 1099s Issued','1096 Transmittal'],
  'Assets': ['Fixed Asset Schedule','Depreciation Report','Equipment Receipts','Real Estate'],
  'Prior Year Returns': ['Federal Return','State Return','Amended Return','Extensions'],
  'Signed Documents': ['Engagement Letter','Federal Return (Signed)','State Return (Signed)','8879 E-File Authorization','Other Signed Documents'],
  'Correspondence': ['IRS Letters','State Notices','Firm Correspondence'],
}

export const TAX_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]

export function getCategories(clientType: string) {
  return clientType === 'business' ? BUSINESS_CATEGORIES : INDIVIDUAL_CATEGORIES
}

export function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    'Income':'💰','Deductions':'📉','Health & Benefits':'🏥','Retirement':'🏦','Real Estate':'🏠',
    'Prior Year Returns':'📋','Identity & Personal':'🪪','Bank Statements':'🏛','Correspondence':'✉️',
    'Signed Documents':'✍️','Financial Statements':'📊','Payroll':'👥','Expenses':'🧾',
    'Tax Documents':'📑','Corporate Documents':'🏢','Accounts Receivable':'📈','Accounts Payable':'📉','Assets':'🏗',
  }
  return icons[category] || '📁'
}
