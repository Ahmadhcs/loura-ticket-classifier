export const CATEGORIES = ['billing', 'technical', 'account', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];


export const TICKET_STATUSES = ['pending', 'processing', 'classified', 'failed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/* Model's output after validation */
export interface Classification {
    category: Category;
    priority: Priority;
    summary: string;
}

/** What the client submits */
export interface NewTicket {
    id: string;
    subject: string; 
    body: string;
}

/** Required fields for all tickets regardless of their status */
export interface TicketBase extends NewTicket {
    attempts: number; 
    createdAt: string;
    updatedAt: string; 
}

/** The ticket's fields depend on their status  */
export type Ticket = | (TicketBase & { status: "pending" | "processing" })
| (TicketBase & { status: "classified"; classification: Classification })
| (TicketBase & { status: "failed"; error: string });