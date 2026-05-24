interface Order {
  id: string;
  total: number;
}

interface Invoice {
  id: string;
  total: number;
}

function formatCurrency(total: number): string {
  const rounded = Math.round(total * 100) / 100;
  return rounded.toFixed(2);
}

export function summarizeOrder(order: Order): string {
  return `Order ${order.id}: $${formatCurrency(order.total)}`;
}

export function summarizeInvoice(invoice: Invoice): string {
  return `Invoice ${invoice.id}: $${formatCurrency(invoice.total)}`;
}
