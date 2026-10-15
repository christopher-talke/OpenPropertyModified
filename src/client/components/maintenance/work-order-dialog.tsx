import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/context";
import { Button } from "@/components/ui/button";
import { ConfirmDelete } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney } from "@/lib/utils";
import type { Expense, PaymentSource, TicketTimelineItem, Unit, WorkOrder, WorkOrderPriority, WorkOrderStatus } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workOrder?: WorkOrder;
  defaults?: { property_id?: number; unit_id?: number };
  onSaved?: () => void;
}

const PRIORITIES: { value: WorkOrderPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const STATUSES: { value: WorkOrderStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In progress" },
  { value: "pending_owner_decision", label: "Pending owner decision" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const PAYMENT_SOURCES: PaymentSource[] = ["Rental Income Deduction", "Owner Contribution"];

export function WorkOrderDialog({ open, onOpenChange, workOrder, defaults, onSaved }: Props) {
  const app = useApp();
  const [units, setUnits] = useState<Unit[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [propertyId, setPropertyId] = useState<number | "">("");
  const [unitId, setUnitId] = useState<number | "">("");
  const [vendorId, setVendorId] = useState<number | "">("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkOrderPriority>("normal");
  const [status, setStatus] = useState<WorkOrderStatus>("open");
  const [scheduledAt, setScheduledAt] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const [timeline, setTimeline] = useState<TicketTimelineItem[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseDialogOpen, setExpenseDialogOpen] = useState(false);
  const [amountOwed, setAmountOwed] = useState("");
  const [amountPaid, setAmountPaid] = useState("");
  const [datePaid, setDatePaid] = useState("");
  const [paymentSource, setPaymentSource] = useState<PaymentSource | "">("");
  const [savingExpense, setSavingExpense] = useState(false);

  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<number | "">("");
  const [mergeCandidates, setMergeCandidates] = useState<WorkOrder[]>([]);
  const [merging, setMerging] = useState(false);

  const ownerContribution = useMemo(
    () => expenses.filter((expense) => expense.payment_source === "Owner Contribution").reduce((sum, expense) => sum + expense.amount_paid, 0),
    [expenses],
  );

  async function loadDetails(ticketId: number) {
    try {
      const [timelineRows, expenseRows] = await Promise.all([
        app.listTicketTimeline(ticketId),
        app.listExpensesForWorkOrder(ticketId),
      ]);
      setTimeline(timelineRows);
      setExpenses(expenseRows);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const all = await app.listUnits();
        setUnits(all);
      } catch (err) {
        app.setError((err as Error).message);
      }
    })();
  }, [open, app]);

  useEffect(() => {
    if (!open) return;
    setPropertyId(workOrder?.property_id ?? defaults?.property_id ?? "");
    setUnitId(workOrder?.unit_id ?? defaults?.unit_id ?? "");
    setVendorId(workOrder?.vendor_id ?? "");
    setTitle(workOrder?.title ?? "");
    setDescription(workOrder?.description ?? "");
    setPriority(workOrder?.priority ?? "normal");
    setStatus(workOrder?.status ?? "open");
    setScheduledAt(workOrder?.scheduled_at?.slice(0, 10) ?? "");
    setCost(workOrder?.cost != null ? String(workOrder.cost) : "");
    setNotes(workOrder?.notes ?? "");
    setTimeline([]);
    setExpenses([]);
    setNewNote("");
    if (workOrder) loadDetails(workOrder.id);
  }, [open, workOrder, defaults]);

  const filteredUnits = useMemo(() => {
    if (!propertyId) return units;
    return units.filter((u) => u.property_id === Number(propertyId));
  }, [units, propertyId]);

  useEffect(() => {
    if (!unitId) return;
    const u = units.find((x) => x.id === Number(unitId));
    if (u && propertyId !== u.property_id) setPropertyId(u.property_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        property_id: propertyId ? Number(propertyId) : null,
        unit_id: unitId ? Number(unitId) : null,
        vendor_id: vendorId ? Number(vendorId) : null,
        title: title.trim(),
        description: description.trim() || null,
        priority,
        status,
        scheduled_at: scheduledAt || null,
        cost: cost ? parseFloat(cost) : null,
        notes: notes.trim() || null,
      };
      if (workOrder) {
        await app.updateWorkOrder(workOrder.id, payload);
      } else {
        await app.createWorkOrder(payload);
      }
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!workOrder) return;
    try {
      await app.deleteWorkOrder(workOrder.id);
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  async function addTimelineNote() {
    if (!workOrder || !newNote.trim()) return;
    setAddingNote(true);
    try {
      await app.createTicketTimelineItem(workOrder.id, { type: "note", message_body: newNote.trim() });
      setNewNote("");
      await loadDetails(workOrder.id);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setAddingNote(false);
    }
  }

  async function addExpense() {
    if (!workOrder) return;
    const resolvedPropertyId = Number(propertyId || workOrder.property_id || 0);
    if (!resolvedPropertyId) {
      app.setError("Select a property before logging an expense.");
      return;
    }
    const owed = parseFloat(amountOwed);
    if (!Number.isFinite(owed) || owed < 0) {
      app.setError("Amount owed must be a valid number.");
      return;
    }

    setSavingExpense(true);
    try {
      await app.createExpenseForWorkOrder(workOrder.id, {
        property_id: resolvedPropertyId,
        amount_owed: owed,
        amount_paid: amountPaid ? parseFloat(amountPaid) : 0,
        date_paid: datePaid || null,
        payment_source: paymentSource || null,
      });
      setAmountOwed("");
      setAmountPaid("");
      setDatePaid("");
      setPaymentSource("");
      setExpenseDialogOpen(false);
      await loadDetails(workOrder.id);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setSavingExpense(false);
    }
  }

  async function removeExpense(expenseId: number) {
    if (!workOrder) return;
    try {
      await app.deleteExpense(expenseId);
      await loadDetails(workOrder.id);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  async function openMergeModal() {
    if (!workOrder) return;
    try {
      const allOrders = await app.listWorkOrders();
      setMergeCandidates(allOrders.filter((candidate) => candidate.id !== workOrder.id));
      setMergeTargetId("");
      setMergeOpen(true);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  async function mergeTicket() {
    if (!workOrder || !mergeTargetId) return;
    setMerging(true);
    try {
      await app.mergeWorkOrders(workOrder.id, Number(mergeTargetId));
      setMergeOpen(false);
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setMerging(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{workOrder ? "Edit work order" : "New work order"}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-3">
            <div>
              <Label htmlFor="wo-title">Title</Label>
              <Input id="wo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leaking kitchen faucet" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Property</Label>
                <Select value={String(propertyId || "")} onValueChange={(v) => { setPropertyId(v ? Number(v) : ""); setUnitId(""); }}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {app.properties.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Unit</Label>
                <Select value={String(unitId || "")} onValueChange={(v) => setUnitId(v ? Number(v) : "")}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {filteredUnits.map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="wo-desc">Description</Label>
              <Textarea id="wo-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as WorkOrderPriority)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as WorkOrderStatus)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Vendor</Label>
                <Select value={String(vendorId || "")} onValueChange={(v) => setVendorId(v ? Number(v) : "")}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {app.vendors.map((v) => (
                      <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="wo-sched">Scheduled date</Label>
                <Input id="wo-sched" type="date" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="wo-cost">Cost</Label>
                <Input id="wo-cost" type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="wo-notes">Notes</Label>
              <Textarea id="wo-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>

            {workOrder ? (
              <>
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">Conversation timeline</h4>
                  </div>
                  <div className="space-y-2">
                    {timeline.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No timeline items yet.</p>
                    ) : (
                      timeline.map((item) => (
                        <div key={item.id} className="rounded-md border p-2 text-sm">
                          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                            <Badge variant={item.type === "email" ? "default" : item.type === "system_activity" ? "outline" : "secondary"}>
                              {item.type.replace("_", " ")}
                            </Badge>
                            <span className="text-muted-foreground">{formatDate(item.timestamp)}</span>
                          </div>
                          {item.sender_email_address ? (
                            <p className="mb-1 text-xs text-muted-foreground">
                              {item.sender_name || "Unknown sender"} · {item.sender_email_address}
                              {item.sender_company_name ? ` · ${item.sender_company_name}` : ""}
                            </p>
                          ) : null}
                          <p className="whitespace-pre-wrap">{item.message_body}</p>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wo-timeline-note">Add decision note</Label>
                    <Textarea id="wo-timeline-note" rows={2} value={newNote} onChange={(e) => setNewNote(e.target.value)} />
                    <Button type="button" variant="secondary" onClick={addTimelineNote} disabled={addingNote || !newNote.trim()}>
                      Add note
                    </Button>
                  </div>
                </div>

                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">Expenses</h4>
                    <Button type="button" variant="secondary" onClick={() => setExpenseDialogOpen(true)}>Log Expense</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Owner Capital Injected: {formatMoney(ownerContribution, app.settings.currency)}
                  </p>
                  <div className="space-y-2">
                    {expenses.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No expenses logged.</p>
                    ) : (
                      expenses.map((expense) => (
                        <div key={expense.id} className="rounded-md border p-2 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span>Owed {formatMoney(expense.amount_owed, app.settings.currency)} · Paid {formatMoney(expense.amount_paid, app.settings.currency)}</span>
                            <Button type="button" variant="ghost" size="sm" onClick={() => removeExpense(expense.id)}>Delete</Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {expense.payment_source ?? "Unspecified source"} · {expense.date_paid ? formatDate(expense.date_paid) : "Unpaid"}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter className="mt-2">
            {workOrder && (
              <Button type="button" variant="outline" className="sm:mr-auto" onClick={openMergeModal}>
                Merge Ticket
              </Button>
            )}
            {workOrder && (
              <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" onClick={save} disabled={saving || !title.trim()}>
              {workOrder ? "Save changes" : "Create work order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={expenseDialogOpen} onOpenChange={setExpenseDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Log expense</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="expense-owed">Amount owed</Label>
              <Input id="expense-owed" type="number" value={amountOwed} onChange={(e) => setAmountOwed(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="expense-paid">Amount paid</Label>
              <Input id="expense-paid" type="number" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="expense-date">Date paid</Label>
              <Input id="expense-date" type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} />
            </div>
            <div>
              <Label>Payment source</Label>
              <Select value={paymentSource} onValueChange={(value) => setPaymentSource(value as PaymentSource)}>
                <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_SOURCES.map((source) => <SelectItem key={source} value={source}>{source}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setExpenseDialogOpen(false)}>Cancel</Button>
            <Button type="button" onClick={addExpense} disabled={savingExpense || !amountOwed}>Save expense</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Merge ticket</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Move this ticket’s timeline and expenses into another open ticket.</p>
            <Select value={String(mergeTargetId || "")} onValueChange={(value) => setMergeTargetId(value ? Number(value) : "")}>
              <SelectTrigger><SelectValue placeholder="Select destination ticket" /></SelectTrigger>
              <SelectContent>
                {mergeCandidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={String(candidate.id)}>
                    #{candidate.id} · {candidate.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setMergeOpen(false)}>Cancel</Button>
            <Button type="button" onClick={mergeTicket} disabled={!mergeTargetId || merging}>Merge</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDelete
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this work order?"
        description="Its history, timeline, and expenses go with it. This cannot be undone."
        onConfirm={remove}
      />
    </>
  );
}
