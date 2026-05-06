interface Order {
  id: string;
  total: number;
}

interface Invoice {
  id: string;
  total: number;
}

export function summarizeOrder(order: Order): string {
  const rounded = Math.round(order.total * 100) / 100;
  const formatted = rounded.toFixed(2);
  return `Order ${order.id}: $${formatted}`;
}

export function summarizeInvoice(invoice: Invoice): string {
  const rounded = Math.round(invoice.total * 100) / 100;
  const formatted = rounded.toFixed(2);
  return `Invoice ${invoice.id}: $${formatted}`;
}
