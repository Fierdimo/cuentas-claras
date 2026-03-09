import React, { useMemo, useState, useCallback } from 'react'
import {
    View,
    Text,
    SectionList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
    Modal,
    ScrollView,
    Pressable,
    TextInput,
    KeyboardAvoidingView,
    Platform,
} from 'react-native'
import { useAuth } from '../hooks/useAuth'
import { useFinancialTimeline, type InvoiceMatch } from '../hooks/useFinancialTimeline'
import type { PendingMovement } from '../hooks/usePendingMovements'
import type { CanonicalInvoice } from '../invoice/types/canonical'

type Period = '7d' | 'month' | 'year' | 'all'

const PERIODS: { key: Period; label: string }[] = [
    { key: '7d', label: '7 días' },
    { key: 'month', label: 'Este mes' },
    { key: 'year', label: 'Este año' },
    { key: 'all', label: 'Todo' },
]

/** Item unificado para la línea de tiempo financiera. */
type TimelineItem =
    | { kind: 'movement'; data: PendingMovement }
    | { kind: 'invoice'; data: CanonicalInvoice }

interface TimelineSection {
    title: string
    data: TimelineItem[]
    net: number
    runningBalance: number
}

function cutoffDate(p: Period): Date {
    const now = new Date()
    if (p === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    if (p === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
    if (p === 'year') return new Date(now.getFullYear(), 0, 1)
    return new Date(0)
}

const MONTH_NAMES_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

interface Props {
    onBack: () => void
}

const BANK_EMOJI: Record<string, string> = {
    Nequi: '💜',
    Bancolombia: '🟡',
    Davivienda: '🔴',
    Daviplata: '🟣',
    'BBVA Colombia': '🔵',
}

const SOURCE_OPTIONS: { key: string; label: string }[] = [
    { key: 'Efectivo', label: '💵 Efectivo' },
    { key: 'Nequi', label: '💜 Nequi' },
    { key: 'Bancolombia', label: '🟡 Bancolombia' },
    { key: 'Davivienda', label: '🔴 Davivienda' },
    { key: 'Daviplata', label: '🟣 Daviplata' },
    { key: 'BBVA Colombia', label: '🔵 BBVA' },
    { key: 'Otro', label: '📝 Otro' },
]

function formatCOP(amount: number): string {
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        minimumFractionDigits: 0,
    }).format(amount)
}

function monthLabel(iso: string | null): string {
    if (!iso) return 'Sin fecha'
    const d = new Date(iso)
    return d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' })
}

function dayLabel(iso: string | null | undefined): string {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })
}

export default function BankMovementsScreen({ onBack }: Props): React.JSX.Element {
    const { user } = useAuth()
    const {
        movements, isLoading, refresh, markAsTransfer, dismissTransfer, ownCounterparts,
        orphanInvoices, possibleMatches, invoiceToMovementMatches, confirmInvoiceLink, dismissInvoiceMatch,
        createManual, deleteManual,
    } = useFinancialTimeline(user?.id ?? null)

    const [selected, setSelected] = useState<TimelineItem | null>(null)
    const [period, setPeriod] = useState<Period>('month')
    const [customMonth, setCustomMonth] = useState<{ year: number; month: number } | null>(null)
    const [showMonthPicker, setShowMonthPicker] = useState(false)
    const [query, setQuery] = useState('')
    const [typeFilter, setTypeFilter] = useState<'all' | 'credit' | 'debit' | 'transfer'>('all')
    const [showNewForm, setShowNewForm] = useState(false)
    const [formDir, setFormDir] = useState<'credit' | 'debit'>('debit')
    const [formAmount, setFormAmount] = useState('')
    const [formDesc, setFormDesc] = useState('')
    const [formSource, setFormSource] = useState('Efectivo')
    const [formDateOffset, setFormDateOffset] = useState(0)  // días hacia atrás desde hoy

    const formDate = useMemo(() => {
        const d = new Date()
        d.setDate(d.getDate() - formDateOffset)
        return d
    }, [formDateOffset])

    const handleSave = useCallback(async () => {
        const amt = Number(formAmount.replace(/\D/g, ''))
        if (!amt) return
        await createManual({
            direction: formDir,
            amount: amt,
            counterpart: formDesc.trim() || null,
            bankName: formSource !== 'Otro' ? formSource : null,
            date: formDate.toISOString(),
        })
        setShowNewForm(false)
        setFormAmount('')
        setFormDesc('')
        setFormDir('debit')
        setFormSource('Efectivo')
        setFormDateOffset(0)
    }, [formAmount, formDesc, formDir, formSource, formDate, createManual])
    // null=unreviewed  true=confirmed transfer  false=user dismissed warning
    //
    // Two detection strategies:
    //   A) Symmetric pair  — opposite directions, same amount (±0), within 48h
    //   B) Self-counterpart — the counterpart field names one of the user’s own banks
    //      (e.g. a Davivienda debit where counterpart = “Nequi” or “Bancolombia”)
    const transferPairs = useMemo(() => {
        const pairs = new Map<string, string | null>()

        for (const m of movements) {
            if (m.is_internal_transfer !== null) continue

            // Strategy A: DB-linked symmetric pair (set by the Postgres insert trigger).
            // Most reliable — exact amount match in opposite directions within 48 h.
            if (m.transfer_pair_id) {
                pairs.set(m.id, m.transfer_pair_id)
                continue
            }

            // Strategy B: counterpart matches a name the user explicitly confirmed as
            // their own (stored in user_own_counterparts via markAsTransfer).
            const cp = (m.counterpart ?? '').toLowerCase().trim()
            if (!cp) continue
            if (ownCounterparts.some(n => cp === n || cp.includes(n) || n.includes(cp))) {
                pairs.set(m.id, null)
            }
        }

        return pairs
    }, [movements, ownCounterparts])

    // ── Available months (movements + orphan invoices) ─────────────────────────
    const availableMonths = useMemo(() => {
        const seen = new Set<string>()
        const result: { year: number; month: number; label: string }[] = []
        const allDates = [
            ...movements.map(m => m.email_date),
            ...orphanInvoices.map(inv => inv.issueDate),
        ]
        for (const date of allDates) {
            if (!date) continue
            const d = new Date(date)
            const key = `${d.getFullYear()}-${d.getMonth()}`
            if (!seen.has(key)) {
                seen.add(key)
                result.push({
                    year: d.getFullYear(),
                    month: d.getMonth(),
                    label: `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getFullYear()}`,
                })
            }
        }
        return result.sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month)
    }, [movements, orphanInvoices])

    // ── Unified filter (movements + orphan invoices) ────────────────────────
    // filteredForTotals: date + search only — used for the summary card so totals
    // never change when the user toggles the type filter.
    const filteredForTotals = useMemo<TimelineItem[]>(() => {
        const q = query.toLowerCase().trim()

        function passesDateFilter(iso: string | null | undefined): boolean {
            const d = iso ? new Date(iso) : null
            if (customMonth) {
                if (!d) return false
                return d.getFullYear() === customMonth.year && d.getMonth() === customMonth.month
            }
            const cutoff = cutoffDate(period)
            return !d || d >= cutoff
        }

        const movs: TimelineItem[] = movements
            .filter(m => {
                if (!passesDateFilter(m.email_date)) return false
                if (q) {
                    const hay = [m.bank_name, m.counterpart, String(Math.round(m.amount))]
                        .filter(Boolean).join(' ').toLowerCase()
                    if (!hay.includes(q)) return false
                }
                return true
            })
            .map(m => ({ kind: 'movement' as const, data: m }))

        const invs: TimelineItem[] = orphanInvoices
            .filter(inv => {
                if (!passesDateFilter(inv.issueDate)) return false
                if (q) {
                    const hay = [
                        inv.issuer?.legalName,
                        inv.invoiceNumber,
                        String(Math.round(inv.totalAmount ?? 0)),
                    ].filter(Boolean).join(' ').toLowerCase()
                    if (!hay.includes(q)) return false
                }
                return true
            })
            .map(inv => ({ kind: 'invoice' as const, data: inv }))

        return [...movs, ...invs]
    }, [movements, orphanInvoices, period, customMonth, query])

    // filtered: adds typeFilter on top — used for the timeline list and sections.
    const filtered = useMemo<TimelineItem[]>(() => {
        const items = filteredForTotals.filter(item => {
            if (item.kind === 'invoice') return typeFilter === 'all' || typeFilter === 'debit'
            const m = item.data
            if (typeFilter === 'credit')   return m.direction === 'credit'
            if (typeFilter === 'transfer') return m.is_internal_transfer === true
            if (typeFilter === 'debit')    return m.direction === 'debit' && m.is_internal_transfer !== true
            return true
        })
        return items.sort((a, b) => {
            const dA = a.kind === 'movement' ? a.data.email_date : a.data.issueDate
            const dB = b.kind === 'movement' ? b.data.email_date : b.data.issueDate
            if (!dA && !dB) return 0
            if (!dA) return 1
            if (!dB) return -1
            return dB.localeCompare(dA)
        })
    }, [filteredForTotals, typeFilter])

    // ── Group by month + per-section net + running balance ──────────────────
    const sections = useMemo<TimelineSection[]>(() => {
        const map = new Map<string, TimelineItem[]>()
        for (const item of filtered) {
            const date = item.kind === 'movement' ? item.data.email_date : item.data.issueDate
            const key = monthLabel(date ?? null)
            const arr = map.get(key) ?? []
            arr.push(item)
            map.set(key, arr)
        }
        const result = Array.from(map.entries()).map(([title, data]) => ({
            title,
            data,
            net: data.reduce((acc, item) => {
                if (item.kind === 'invoice') return acc - (item.data.totalAmount ?? 0)
                const m = item.data
                if (m.is_internal_transfer === true) return acc
                return acc + (m.direction === 'credit' ? m.amount : -m.amount)
            }, 0),
            runningBalance: 0,
        }))
        let running = 0
        for (let i = result.length - 1; i >= 0; i--) {
            running += result[i].net
            result[i].runningBalance = running
        }
        return result
    }, [filtered])

    // ── Totals for current filter ───────────────────────────────────────────────────
    // Uses filteredForTotals (no typeFilter) so the card never changes when toggling.
    const totals = useMemo(() => {
        let income = 0, expense = 0, transferAmt = 0, pendingTransferPairs = 0
        let invoiceMatchCount = 0
        for (const item of filteredForTotals) {
            if (item.kind === 'invoice') {
                expense += item.data.totalAmount ?? 0
                continue
            }
            const m = item.data
            if (m.is_internal_transfer === true) { transferAmt += m.amount; continue }
            if (m.is_internal_transfer === null && transferPairs.has(m.id)) pendingTransferPairs++
            if (m.direction === 'credit') income += m.amount
            else expense += m.amount
            if (possibleMatches.has(m.id)) invoiceMatchCount++
        }
        return {
            income,
            expense,
            transferAmt,
            pendingTransfers: Math.round(pendingTransferPairs / 2),
            invoiceMatchCount,
            net: income - expense,
        }
    }, [filteredForTotals, transferPairs, possibleMatches])

    // All-time balance — always from ALL movements + orphan invoices, ignoring filter.
    // Orphan invoices = real expenses not backed by a detected bank notification.
    const allTimeBalance = useMemo(() => {
        let net = 0
        for (const m of movements) {
            if (m.is_internal_transfer === true) continue
            net += m.direction === 'credit' ? m.amount : -m.amount
        }
        for (const inv of orphanInvoices) {
            net -= inv.totalAmount ?? 0
        }
        return net
    }, [movements, orphanInvoices])

    // Label for the period breakdown row in the summary card
    const periodLabel = customMonth
        ? `${MONTH_NAMES_SHORT[customMonth.month]} ${customMonth.year}`
        : period === '7d' ? 'últimos 7 días'
            : period === 'month' ? 'este mes'
                : period === 'year' ? 'este año'
                    : null

    // ── renderItem ────────────────────────────────────────────────────────────
    const renderItem = ({ item }: { item: TimelineItem }) => {
        // ── Invoice (huérfana) ──
        if (item.kind === 'invoice') {
            const inv = item.data
            const name = inv.issuer?.legalName ?? 'Factura'
            const movMatches = invoiceToMovementMatches.get(inv.id)
            const bestMovConf = movMatches?.[0]?.confidence
            return (
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => setSelected(item)}
                    activeOpacity={0.7}
                >
                    <View style={[styles.rowIconBg, { backgroundColor: '#fff7ed' }]}>
                        <Text style={styles.rowEmoji}>🧾</Text>
                    </View>
                    <View style={styles.rowBody}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text style={styles.rowBank} numberOfLines={1}>{name}</Text>
                            {!bestMovConf && <Text style={styles.badgeOrphanInvoice}>sin movimiento</Text>}
                            {bestMovConf === 'probable' && <Text style={styles.badgeInvoiceProbable}>🏦 mov. detectado</Text>}
                            {bestMovConf === 'possible' && <Text style={styles.badgeInvoicePossible}>🏦 mov. posible</Text>}
                        </View>
                        <Text style={styles.rowCounterpart} numberOfLines={1}>{'Factura '}{inv.invoiceNumber}</Text>
                        <Text style={styles.rowDate}>{dayLabel(inv.issueDate)}</Text>
                    </View>
                    <View style={styles.rowRight}>
                        <Text style={[styles.rowAmount, styles.debit]}>-{formatCOP(inv.totalAmount ?? 0)}</Text>
                        <Text style={styles.rowChevron}>›</Text>
                    </View>
                </TouchableOpacity>
            )
        }

        // ── Movement ──
        const m = item.data
        const isCredit = m.direction === 'credit'
        const emoji = BANK_EMOJI[m.bank_name ?? ''] ?? '🏦'
        const isTransfer = m.is_internal_transfer === true
        const isPotential = m.is_internal_transfer === null && transferPairs.has(m.id)
        const linkedInvoice = !!m.linked_invoice_id
        const bestMatch = !linkedInvoice ? possibleMatches.get(m.id)?.[0] : undefined

        return (
            <TouchableOpacity
                style={[styles.row, isTransfer && styles.rowTransfer]}
                onPress={() => setSelected(item)}
                activeOpacity={0.7}
            >
                <View style={[styles.rowIconBg, { backgroundColor: isTransfer ? '#f3f4f6' : isCredit ? '#f0fdf4' : '#fff5f5' }]}>
                    <Text style={[styles.rowEmoji, isTransfer && { opacity: 0.4 }]}>{emoji}</Text>
                </View>
                <View style={styles.rowBody}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={[styles.rowBank, isTransfer && { color: '#9ca3af' }]}>{m.bank_name ?? 'Banco'}</Text>
                        {isTransfer && <Text style={styles.badgeTransfer}>⇄ interna</Text>}
                        {isPotential && <Text style={styles.badgePotential}>⇄ revisar</Text>}
                        {linkedInvoice && <Text style={styles.badgeInvoiceLinked}>🧾 factura</Text>}
                        {bestMatch?.confidence === 'probable' && (
                            <Text style={styles.badgeInvoiceProbable}>🧾 detectada</Text>
                        )}
                        {bestMatch?.confidence === 'possible' && (
                            <Text style={styles.badgeInvoicePossible}>🧾 posible</Text>
                        )}
                    </View>
                    {m.counterpart
                        ? <Text style={styles.rowCounterpart} numberOfLines={1}>
                            {isCredit ? '← ' : '→ '}{m.counterpart}
                        </Text>
                        : null
                    }
                    <Text style={styles.rowDate}>
                        {dayLabel(m.email_date)}{m.account_last4 ? ` · ****${m.account_last4}` : ''}
                    </Text>
                </View>
                <View style={styles.rowRight}>
                    <Text style={[
                        styles.rowAmount,
                        isTransfer ? styles.amountTransfer : isCredit ? styles.credit : styles.debit,
                    ]}>
                        {isCredit ? '+' : '-'}{formatCOP(m.amount)}
                    </Text>
                    <Text style={styles.rowChevron}>›</Text>
                </View>
            </TouchableOpacity>
        )
    }

    return (
        <View style={styles.container}>

            {/* ── Header ── */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={styles.backBtn}>Volver</Text>
                </TouchableOpacity>
                <Text style={styles.title}>Movimientos</Text>
                <Text style={styles.headerCount}>(?)</Text>
            </View>

            {/* ── Summary card ── */}
            {!isLoading && (
                <View style={styles.summaryCard}>
                    <View style={styles.summaryMain}>
                        <Text style={styles.summaryNetLabel}>Balance total</Text>
                        <Text style={[styles.summaryNet, allTimeBalance >= 0 ? styles.credit : styles.debit]}>
                            {allTimeBalance >= 0 ? '+' : ''}{formatCOP(allTimeBalance)}
                        </Text>
                    </View>
                    <View style={styles.summaryDivider} />
                    {periodLabel && (
                        <Text style={styles.summaryPeriodLabel}>{periodLabel}</Text>
                    )}
                    <View style={styles.summaryRow}>
                        <TouchableOpacity
                            style={[styles.summaryCol, typeFilter === 'credit' && styles.summaryColActive]}
                            onPress={() => setTypeFilter(f => f === 'credit' ? 'all' : 'credit')}
                            activeOpacity={0.75}
                        >
                            <Text style={styles.summaryLabel}>↙️ Ingresos</Text>
                            <Text style={[styles.summaryAmount, styles.credit]}>{formatCOP(totals.income)}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.summaryCol, typeFilter === 'debit' && styles.summaryColActive]}
                            onPress={() => setTypeFilter(f => f === 'debit' ? 'all' : 'debit')}
                            activeOpacity={0.75}
                        >
                            <Text style={styles.summaryLabel}>↗️ Gastos</Text>
                            <Text style={[styles.summaryAmount, styles.debit]}>{formatCOP(totals.expense)}</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.summaryCol, typeFilter === 'transfer' && styles.summaryColActive]}
                            onPress={() => setTypeFilter(f => f === 'transfer' ? 'all' : 'transfer')}
                            activeOpacity={0.75}
                        >
                            <Text style={styles.summaryLabel}>⇄ Transfer.</Text>
                            <Text style={[styles.summaryAmount, { color: '#9ca3af' }]}>{formatCOP(totals.transferAmt)}</Text>
                        </TouchableOpacity>

                    </View>
                </View>
            )}

            {/* ── Potential transfers warning ── */}
            {!isLoading && totals.pendingTransfers > 0 && (
                <View style={styles.warningBanner}>
                    <Text style={styles.warningBannerText}>
                        {'⇄'} {totals.pendingTransfers} posible{totals.pendingTransfers > 1 ? 's' : ''} transferencia{totals.pendingTransfers > 1 ? 's' : ''} interna{totals.pendingTransfers > 1 ? 's' : ''} — revisa los marcados
                    </Text>
                </View>
            )}

            {/* ── Invoice match warning ── */}
            {!isLoading && totals.invoiceMatchCount > 0 && (
                <View style={[styles.warningBanner, styles.warningBannerInvoice]}>
                    <Text style={[styles.warningBannerText, styles.warningBannerInvoiceText]}>
                        {'🧾'} {totals.invoiceMatchCount} movimiento{totals.invoiceMatchCount > 1 ? 's' : ''} con factura detectada — toca para vincular
                    </Text>
                </View>
            )}

            {/* ── Period pills + month picker button ── */}
            <View style={styles.pillsRow}>
                {customMonth ? (
                    // Active custom month — shown as a dismissible pill
                    <>
                        <View style={[styles.pill, styles.pillActive, styles.pillCustom]}>
                            <Text style={[styles.pillText, styles.pillTextActive]}>
                                {MONTH_NAMES_SHORT[customMonth.month]} {customMonth.year}
                            </Text>
                            <TouchableOpacity
                                onPress={() => setCustomMonth(null)}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                                <Text style={styles.pillCustomClose}> ×</Text>
                            </TouchableOpacity>
                        </View>
                        <TouchableOpacity
                            style={styles.pill}
                            onPress={() => setShowMonthPicker(true)}
                        >
                            <Text style={styles.pillText}>📅</Text>
                        </TouchableOpacity>
                    </>
                ) : (
                    // Quick-access pills
                    <>
                        {PERIODS.map(p => (
                            <TouchableOpacity
                                key={p.key}
                                style={[styles.pill, period === p.key && styles.pillActive]}
                                onPress={() => setPeriod(p.key)}
                            >
                                <Text style={[styles.pillText, period === p.key && styles.pillTextActive]}>{p.label}</Text>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            style={[styles.pill, styles.pillCalendar]}
                            onPress={() => setShowMonthPicker(true)}
                        >
                            <Text style={styles.pillText}>📅</Text>
                        </TouchableOpacity>
                    </>
                )}
            </View>

            {/* ── Month picker modal ── */}
            <Modal
                visible={showMonthPicker}
                transparent
                animationType="slide"
                onRequestClose={() => setShowMonthPicker(false)}
            >
                <Pressable style={styles.modalBackdrop} onPress={() => setShowMonthPicker(false)} />
                <View style={[styles.modalSheet, styles.pickerSheet]}>
                    <View style={styles.modalHandle} />
                    <Text style={styles.pickerTitle}>Seleccionar mes</Text>
                    <ScrollView contentContainerStyle={styles.pickerBody} showsVerticalScrollIndicator={false}>
                        {/* Group by year */}
                        {Array.from(new Set(availableMonths.map(m => m.year)))
                            .map(year => (
                                <View key={year} style={styles.pickerYearGroup}>
                                    <Text style={styles.pickerYearLabel}>{year}</Text>
                                    <View style={styles.pickerMonthsRow}>
                                        {availableMonths
                                            .filter(m => m.year === year)
                                            .map(m => {
                                                const isActive = customMonth?.year === m.year && customMonth?.month === m.month
                                                return (
                                                    <TouchableOpacity
                                                        key={m.month}
                                                        style={[styles.pickerMonthChip, isActive && styles.pickerMonthChipActive]}
                                                        onPress={() => {
                                                            setCustomMonth({ year: m.year, month: m.month })
                                                            setShowMonthPicker(false)
                                                        }}
                                                    >
                                                        <Text style={[styles.pickerMonthText, isActive && styles.pickerMonthTextActive]}>
                                                            {MONTH_NAMES_SHORT[m.month]}
                                                        </Text>
                                                    </TouchableOpacity>
                                                )
                                            })
                                        }
                                    </View>
                                </View>
                            ))
                        }
                    </ScrollView>
                </View>
            </Modal>

            {/* ── Search bar ── */}
            <View style={styles.searchRow}>
                <Text style={styles.searchIcon}>{'🔍'}</Text>
                <TextInput
                    style={styles.searchInput}
                    placeholder="Buscar banco, persona, monto…"
                    placeholderTextColor="#9ca3af"
                    value={query}
                    onChangeText={setQuery}
                    returnKeyType="search"
                    autoCorrect={false}
                    autoCapitalize="none"
                />
                {query.length > 0 && (
                    <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={styles.searchClear}>✕</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* ── List ── */}
            {isLoading ? (
                <ActivityIndicator style={{ marginTop: 40 }} color="#2563eb" size="large" />
            ) : (
                <SectionList<TimelineItem, TimelineSection>
                    sections={sections}
                    keyExtractor={item =>
                        item.kind === 'movement' ? item.data.id : `inv:${item.data.id}`
                    }
                    renderItem={renderItem}
                    renderSectionHeader={({ section }) => {
                        const showRunning = sections.length > 1
                        const runningPositive = section.runningBalance >= 0
                        return (
                            <View style={styles.sectionHeaderRow}>
                                <Text style={styles.sectionHeader}>{section.title}</Text>
                                <View style={styles.sectionNetCol}>
                                    <Text style={[styles.sectionNet, section.net >= 0 ? styles.credit : styles.debit]}>
                                        {section.net >= 0 ? '+' : ''}{formatCOP(section.net)}
                                    </Text>
                                    {showRunning && (
                                        <Text style={[styles.sectionRunning, runningPositive ? styles.credit : styles.debit]}>
                                            acum. {section.runningBalance >= 0 ? '+' : ''}{formatCOP(section.runningBalance)}
                                        </Text>
                                    )}
                                </View>
                            </View>
                        )
                    }}
                    stickySectionHeadersEnabled={false}
                    contentContainerStyle={styles.list}
                    refreshControl={
                        <RefreshControl refreshing={false} onRefresh={() => void refresh()} />
                    }
                    ListEmptyComponent={
                        <View style={styles.empty}>
                            <Text style={styles.emptyIcon}>{query ? '🔍' : '🏦'}</Text>
                            <Text style={styles.emptyText}>
                                {query ? 'Sin resultados' : 'Sin movimientos en este período'}
                            </Text>
                            <Text style={styles.emptySubtext}>
                                {query
                                    ? `No hay elementos que coincidan con "${query}"`
                                    : 'Los movimientos y facturas se detectan automáticamente desde tus correos'}
                            </Text>
                        </View>
                    }
                />
            )}

            {/* ── Detail modal ── */}
            <Modal
                visible={selected !== null}
                animationType="slide"
                transparent
                onRequestClose={() => setSelected(null)}
            >
                <Pressable style={styles.modalBackdrop} onPress={() => setSelected(null)} />

                {/* ── Invoice modal ── */}
                {selected?.kind === 'invoice' && (() => {
                    const inv = selected.data
                    return (
                        <View style={styles.modalSheet}>
                            <View style={styles.modalHandle} />
                            <View style={styles.modalHeader}>
                                <Text style={styles.modalEmoji}>🧾</Text>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.modalBank}>{inv.issuer?.legalName ?? 'Factura electrónica'}</Text>
                                    <Text style={[styles.modalAmount, styles.debit]}>
                                        -{formatCOP(inv.totalAmount ?? 0)}
                                    </Text>
                                </View>
                                <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                                    <Text style={styles.modalClose}>✕</Text>
                                </TouchableOpacity>
                            </View>
                            <ScrollView contentContainerStyle={styles.modalBody} showsVerticalScrollIndicator={false}>
                                <DetailRow label="N° Factura" value={inv.invoiceNumber} />
                                {inv.issueDate && (
                                    <DetailRow
                                        label="Fecha"
                                        value={new Date(inv.issueDate).toLocaleDateString('es-CO', { dateStyle: 'long' })}
                                    />
                                )}
                                {inv.issuer?.legalName && <DetailRow label="Proveedor" value={inv.issuer.legalName} />}
                                {inv.issuer?.taxId && <DetailRow label="NIT" value={inv.issuer.taxId} />}
                                <DetailRow label="Moneda" value={inv.currency} />

                                {/* ── Movimiento sugerido (vista inversa) ── */}
                                {(() => {
                                    const movMatches = invoiceToMovementMatches.get(inv.id)
                                    const best = movMatches?.[0]
                                    if (!best) {
                                        return (
                                            <View style={styles.snippetBox}>
                                                <Text style={styles.snippetLabel}>Sin movimiento bancario confirmado</Text>
                                                <Text style={styles.snippetText}>
                                                    No detectamos una notificación bancaria para esta factura. Puede haberse
                                                    pagado con tarjeta de crédito, efectivo u otro método no monitoreado.
                                                </Text>
                                            </View>
                                        )
                                    }
                                    const m = best.movement
                                    const bankEmoji = BANK_EMOJI[m.bank_name ?? ''] ?? '🏦'
                                    return (
                                        <View style={styles.invoiceMatchBox}>
                                            <Text style={styles.invoiceMatchTitle}>
                                                {best.confidence === 'probable'
                                                    ? '🏦 Movimiento probable detectado'
                                                    : '🏦 Posible movimiento relacionado'}
                                            </Text>
                                            <Text style={styles.invoiceMatchSub}>
                                                {`${bankEmoji} ${m.bank_name ?? 'Banco'} — ${formatCOP(m.amount)} el ${dayLabel(m.email_date)}${m.counterpart ? ` (→ ${m.counterpart})` : ''}. ¿Es el pago de esta factura?`}
                                            </Text>
                                            <View style={styles.invoiceMatchActions}>
                                                <TouchableOpacity
                                                    style={styles.invoiceBtnPrimary}
                                                    onPress={() => { void confirmInvoiceLink(m.id, inv.id); setSelected(null) }}
                                                >
                                                    <Text style={styles.invoiceBtnPrimaryText}>Sí, es el mismo</Text>
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    style={styles.invoiceBtnSecondary}
                                                    onPress={() => { void dismissInvoiceMatch(m.id, inv.id); setSelected(null) }}
                                                >
                                                    <Text style={styles.invoiceBtnSecondaryText}>No es el mismo</Text>
                                                </TouchableOpacity>
                                            </View>
                                        </View>
                                    )
                                })()}
                            </ScrollView>
                        </View>
                    )
                })()}

                {/* ── Movement modal ── */}
                {selected?.kind === 'movement' && (() => {
                    const m = selected.data
                    return (
                        <View style={styles.modalSheet}>
                            <View style={styles.modalHandle} />
                            <View style={styles.modalHeader}>
                                <Text style={styles.modalEmoji}>
                                    {m.source === 'manual' ? '✏️' : (BANK_EMOJI[m.bank_name ?? ''] ?? '🏦')}
                                </Text>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.modalBank}>{m.bank_name ?? 'Banco'}</Text>
                                    <Text style={[
                                        styles.modalAmount,
                                        m.direction === 'credit' ? styles.credit : styles.debit,
                                    ]}>
                                        {m.direction === 'credit' ? '+' : '-'}{formatCOP(m.amount)}
                                    </Text>
                                </View>
                                <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                                    <Text style={styles.modalClose}>✕</Text>
                                </TouchableOpacity>
                            </View>

                            <ScrollView contentContainerStyle={styles.modalBody} showsVerticalScrollIndicator={false}>
                                <DetailRow label="Tipo" value={m.direction === 'credit' ? '↙ Ingreso' : '↗ Gasto'} />
                                {m.counterpart && <DetailRow label="Contraparte" value={m.counterpart} />}
                                {m.account_last4 && <DetailRow label="Cuenta" value={`****${m.account_last4}`} />}
                                {m.email_date && (
                                    <DetailRow
                                        label="Fecha"
                                        value={new Date(m.email_date).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' })}
                                    />
                                )}
                                {m.sender_email && m.source !== 'manual' && <DetailRow label="Remitente" value={m.sender_email} />}
                                <DetailRow label="Origen" value={m.source === 'manual' ? '✏️ Entrada manual' : m.parser_used} />

                                {/* ── Transfer section ── */}
                                {m.is_internal_transfer === true ? (
                                    <View style={styles.transferBox}>
                                        <Text style={styles.transferBoxTitle}>⇄ Transferencia interna confirmada</Text>
                                        <Text style={styles.transferBoxSub}>
                                            Este movimiento está excluido de los totales de ingresos y gastos.
                                        </Text>
                                        <View style={styles.transferBoxActions}>
                                            <TouchableOpacity
                                                style={styles.transferBtnSecondary}
                                                onPress={() => { void dismissTransfer(m.id); setSelected(null) }}
                                            >
                                                <Text style={styles.transferBtnSecondaryText}>Desmarcar</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ) : m.is_internal_transfer === null && transferPairs.has(m.id) ? (
                                    <View style={styles.transferBox}>
                                        <Text style={styles.transferBoxTitle}>⇄ Posible transferencia entre tus cuentas</Text>
                                        <Text style={styles.transferBoxSub}>
                                            {transferPairs.get(m.id) !== null
                                                ? 'Detectamos otro movimiento del mismo valor en las últimas 48 h. ¿Es un traslado entre tus propias cuentas?'
                                                : `La contraparte "${m.counterpart}" parece ser una de tus propias cuentas. ¿Es un traslado interno?`
                                            }
                                        </Text>
                                        <View style={styles.transferBoxActions}>
                                            <TouchableOpacity
                                                style={styles.transferBtnPrimary}
                                                onPress={() => { void markAsTransfer([m.id]); setSelected(null) }}
                                            >
                                                <Text style={styles.transferBtnPrimaryText}>Sí, es transferencia</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={styles.transferBtnSecondary}
                                                onPress={() => { void dismissTransfer(m.id); setSelected(null) }}
                                            >
                                                <Text style={styles.transferBtnSecondaryText}>No, mantener</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ) : m.is_internal_transfer === false ? null : (
                                    <TouchableOpacity
                                        style={styles.transferManualBtn}
                                        onPress={() => { void markAsTransfer([m.id]); setSelected(null) }}
                                    >
                                        <Text style={styles.transferManualBtnText}>⇄ Marcar como transferencia interna</Text>
                                    </TouchableOpacity>
                                )}

                                {/* ── Invoice match / linked invoice ── */}
                                {(() => {
                                    const matches = possibleMatches.get(m.id)
                                    const bestMatch = matches?.[0]
                                    if (m.linked_invoice_id) {
                                        return (
                                            <View style={styles.invoiceLinkedBox}>
                                                <Text style={styles.invoiceLinkedTitle}>🧾 Factura vinculada</Text>
                                                <Text style={styles.invoiceLinkedSub}>
                                                    Este movimiento tiene una factura electrónica confirmada y no se cuenta doble.
                                                </Text>
                                            </View>
                                        )
                                    }
                                    if (bestMatch) {
                                        const inv = bestMatch.invoice
                                        return (
                                            <View style={styles.invoiceMatchBox}>
                                                <Text style={styles.invoiceMatchTitle}>
                                                    {bestMatch.confidence === 'probable'
                                                        ? '🧾 Factura probable detectada'
                                                        : '🧾 Posible factura relacionada'}
                                                </Text>
                                                <Text style={styles.invoiceMatchSub}>
                                                    {`Factura de "${inv.issuer?.legalName ?? '...'}" por ${formatCOP(inv.totalAmount ?? 0)} del ${dayLabel(inv.issueDate)}. ¿Es el comprobante de este pago?`}
                                                </Text>
                                                <View style={styles.invoiceMatchActions}>
                                                    <TouchableOpacity
                                                        style={styles.invoiceBtnPrimary}
                                                        onPress={() => { void confirmInvoiceLink(m.id, inv.id); setSelected(null) }}
                                                    >
                                                        <Text style={styles.invoiceBtnPrimaryText}>Sí, es la misma</Text>
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                        style={styles.invoiceBtnSecondary}
                                                        onPress={() => { void dismissInvoiceMatch(m.id, inv.id); setSelected(null) }}
                                                    >
                                                        <Text style={styles.invoiceBtnSecondaryText}>No es la misma</Text>
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                        )
                                    }
                                    return null
                                })()}

                                {m.body_snippet && (
                                    <View style={styles.snippetBox}>
                                        <Text style={styles.snippetLabel}>Fragmento del correo</Text>
                                        <Text style={styles.snippetText}>{m.body_snippet}</Text>
                                    </View>
                                )}

                                {/* ── Eliminar movimiento manual ── */}
                                {m.source === 'manual' && (
                                    <TouchableOpacity
                                        style={styles.deleteManualBtn}
                                        onPress={() => { void deleteManual(m.id); setSelected(null) }}
                                    >
                                        <Text style={styles.deleteManualBtnText}>🗑 Eliminar movimiento manual</Text>
                                    </TouchableOpacity>
                                )}
                            </ScrollView>
                        </View>
                    )
                })()}
            </Modal>

            {/* ── FAB: nuevo movimiento manual ── */}
            <TouchableOpacity style={styles.fab} onPress={() => setShowNewForm(true)} activeOpacity={0.85}>
                <Text style={styles.fabText}>+</Text>
            </TouchableOpacity>

            {/* ── Form modal: nuevo movimiento manual ── */}
            <Modal
                visible={showNewForm}
                animationType="slide"
                transparent
                onRequestClose={() => setShowNewForm(false)}
            >
                <Pressable style={styles.modalBackdrop} onPress={() => setShowNewForm(false)} />
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                    style={styles.modalSheet}
                >
                    <View style={styles.modalHandle} />
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalEmoji}>✏️</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.modalBank}>Movimiento manual</Text>
                            <Text style={[styles.modalAmount, formDir === 'debit' ? styles.debit : styles.credit]}>
                                {formAmount
                                    ? `${formDir === 'debit' ? '-' : '+'}${formatCOP(Number(formAmount.replace(/\D/g, '')) || 0)}`
                                    : '—'}
                            </Text>
                        </View>
                        <TouchableOpacity onPress={() => setShowNewForm(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                            <Text style={styles.modalClose}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    <ScrollView
                        contentContainerStyle={styles.formBody}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                        {/* Dirección */}
                        <View style={styles.formDirRow}>
                            <TouchableOpacity
                                style={[styles.dirBtn, formDir === 'credit' && styles.dirBtnCreditActive]}
                                onPress={() => setFormDir('credit')}
                            >
                                <Text style={[styles.dirBtnText, formDir === 'credit' && styles.dirBtnTextActive]}>💚 Ingreso</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.dirBtn, formDir === 'debit' && styles.dirBtnDebitActive]}
                                onPress={() => setFormDir('debit')}
                            >
                                <Text style={[styles.dirBtnText, formDir === 'debit' && styles.dirBtnTextActive]}>🔴 Gasto</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Monto */}
                        <Text style={styles.formLabel}>Monto (COP)</Text>
                        <TextInput
                            style={styles.formInput}
                            value={formAmount}
                            onChangeText={t => setFormAmount(t.replace(/[^0-9]/g, ''))}
                            placeholder="0"
                            placeholderTextColor="#d1d5db"
                            keyboardType="numeric"
                        />

                        {/* Descripción */}
                        <Text style={styles.formLabel}>Descripción (contraparte)</Text>
                        <TextInput
                            style={styles.formInput}
                            value={formDesc}
                            onChangeText={setFormDesc}
                            placeholder="Ej: Supermercado Éxito, Salario enero…"
                            placeholderTextColor="#d1d5db"
                            autoCapitalize="sentences"
                            returnKeyType="done"
                        />

                        {/* Medio de pago */}
                        <Text style={styles.formLabel}>Medio de pago / fuente</Text>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.formChipsRow}
                            keyboardShouldPersistTaps="handled"
                        >
                            {SOURCE_OPTIONS.map(opt => (
                                <TouchableOpacity
                                    key={opt.key}
                                    style={[styles.formChip, formSource === opt.key && styles.formChipActive]}
                                    onPress={() => setFormSource(opt.key)}
                                >
                                    <Text style={[styles.formChipText, formSource === opt.key && styles.formChipTextActive]}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>

                        {/* Fecha */}
                        <Text style={styles.formLabel}>Fecha</Text>
                        <View style={styles.formDateRow}>
                            <TouchableOpacity style={styles.formDateArrow} onPress={() => setFormDateOffset(o => o + 1)}>
                                <Text style={styles.formDateArrowText}>‹</Text>
                            </TouchableOpacity>
                            <Text style={styles.formDateLabel}>
                                {formDate.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                            </Text>
                            <TouchableOpacity style={styles.formDateArrow} onPress={() => setFormDateOffset(o => Math.max(0, o - 1))}>
                                <Text style={styles.formDateArrowText}>›</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Guardar */}
                        <TouchableOpacity
                            style={[styles.saveBtn, (!formAmount || Number(formAmount) <= 0) && styles.saveBtnDisabled]}
                            disabled={!formAmount || Number(formAmount) <= 0}
                            onPress={() => { void handleSave() }}
                        >
                            <Text style={styles.saveBtnText}>Guardar movimiento</Text>
                        </TouchableOpacity>
                    </ScrollView>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    )
}

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{label}</Text>
            <Text style={styles.detailValue}>{value}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f3f4f6' },

    // Header
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
    backBtn: { fontSize: 15, color: '#2563eb', fontWeight: '500', width: 72 },
    title: { fontSize: 17, fontWeight: '700', color: '#111827' },
    headerCount: { width: 72, textAlign: 'right', fontSize: 13, color: '#9ca3af' },

    // Summary card (dark)
    summaryCard: { backgroundColor: '#1e293b', marginHorizontal: 16, marginTop: 14, borderRadius: 18, padding: 18, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 4 },
    summaryMain: { alignItems: 'center', marginBottom: 14 },
    summaryNetLabel: { fontSize: 11, color: 'rgba(255,255,255,0.45)', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4 },
    summaryNet: { fontSize: 30, fontWeight: '800' },
    summaryDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.1)', marginBottom: 10 },
    summaryPeriodLabel: { fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.6, textAlign: 'center', marginBottom: 8 },
    summaryRow: { flexDirection: 'row' },
    summaryCol: { flex: 1, alignItems: 'center' },
    summaryColActive: { backgroundColor: 'rgba(255,255,255,0.13)', borderRadius: 10, paddingVertical: 6 },
    summaryLabel: { fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 4 },
    summaryAmount: { fontSize: 15, fontWeight: '700' },

    // Period pills
    pillsRow: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6, alignItems: 'center' },
    pill: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5e7eb', marginRight: 8 },
    pillActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
    pillText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
    pillTextActive: { color: '#fff' },
    pillCustom: { flexDirection: 'row', alignItems: 'center' },
    pillCustomClose: { fontSize: 14, color: '#fff', fontWeight: '700' },
    pillCalendar: { marginLeft: 'auto' as unknown as number },

    // Month picker sheet
    pickerSheet: { maxHeight: '70%' },
    pickerTitle: { fontSize: 16, fontWeight: '700', color: '#111827', textAlign: 'center', marginBottom: 16, paddingHorizontal: 20 },
    pickerBody: { paddingHorizontal: 20, paddingBottom: 32 },
    pickerYearGroup: { marginBottom: 20 },
    pickerYearLabel: { fontSize: 12, fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
    pickerMonthsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    pickerMonthChip: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
    pickerMonthChipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
    pickerMonthText: { fontSize: 13, fontWeight: '600', color: '#374151' },
    pickerMonthTextActive: { color: '#fff' },

    // Search
    searchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 6, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: '#e5e7eb', gap: 8 },
    searchIcon: { fontSize: 14 },
    searchInput: { flex: 1, fontSize: 14, color: '#111827', paddingVertical: 11 },
    searchClear: { fontSize: 13, color: '#9ca3af', padding: 4 },

    // List
    list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32 },
    sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 18, paddingBottom: 8 },
    sectionHeader: { fontSize: 11, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8 },
    sectionNetCol: { alignItems: 'flex-end', gap: 1 },
    sectionNet: { fontSize: 12, fontWeight: '700' },
    sectionRunning: { fontSize: 10, fontWeight: '500', opacity: 0.65 },

    row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8, gap: 12, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
    rowIconBg: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
    rowEmoji: { fontSize: 20 },
    rowBody: { flex: 1, gap: 2 },
    rowBank: { fontSize: 14, fontWeight: '600', color: '#111827' },
    rowCounterpart: { fontSize: 12, color: '#6b7280' },
    rowDate: { fontSize: 11, color: '#d1d5db' },
    rowRight: { alignItems: 'flex-end', gap: 2 },
    rowAmount: { fontSize: 15, fontWeight: '700' },
    rowChevron: { fontSize: 16, color: '#d1d5db' },
    credit: { color: '#16a34a' },
    debit: { color: '#dc2626' },
    amountTransfer: { color: '#9ca3af' },

    rowTransfer: { opacity: 0.65 },
    badgeTransfer: { fontSize: 10, fontWeight: '600', color: '#6b7280', backgroundColor: '#f3f4f6', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    badgePotential: { fontSize: 10, fontWeight: '600', color: '#92400e', backgroundColor: '#fef3c7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    badgeInvoiceLinked: { fontSize: 10, fontWeight: '600', color: '#065f46', backgroundColor: '#d1fae5', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    badgeInvoiceProbable: { fontSize: 10, fontWeight: '600', color: '#1d4ed8', backgroundColor: '#dbeafe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    badgeInvoicePossible: { fontSize: 10, fontWeight: '600', color: '#6d28d9', backgroundColor: '#ede9fe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    badgeOrphanInvoice: { fontSize: 10, fontWeight: '600', color: '#c2410c', backgroundColor: '#ffedd5', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },

    // Warning banners
    warningBanner: { marginHorizontal: 16, marginTop: 8, backgroundColor: '#fef3c7', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
    warningBannerText: { fontSize: 12, color: '#92400e', lineHeight: 17 },
    warningBannerInvoice: { backgroundColor: '#ecfdf5' },
    warningBannerInvoiceText: { color: '#065f46' },

    // Transfer box inside modal
    transferBox: { marginTop: 16, backgroundColor: '#fffbeb', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#fde68a' },
    transferBoxTitle: { fontSize: 13, fontWeight: '700', color: '#92400e', marginBottom: 6 },
    transferBoxSub: { fontSize: 12, color: '#78350f', lineHeight: 18, marginBottom: 12 },
    transferBoxActions: { flexDirection: 'row', gap: 8 },
    transferBtnPrimary: { flex: 1, backgroundColor: '#f59e0b', borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
    transferBtnPrimaryText: { fontSize: 13, fontWeight: '700', color: '#fff' },
    transferBtnSecondary: { flex: 1, backgroundColor: '#fff', borderRadius: 8, paddingVertical: 9, alignItems: 'center', borderWidth: 1, borderColor: '#fde68a' },
    transferBtnSecondaryText: { fontSize: 13, fontWeight: '600', color: '#92400e' },
    transferManualBtn: { marginTop: 16, paddingVertical: 12, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#f3f4f6' },
    transferManualBtnText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },

    // Invoice match box (inside movement modal)
    invoiceMatchBox: { marginTop: 16, backgroundColor: '#eff6ff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#bfdbfe' },
    invoiceMatchTitle: { fontSize: 13, fontWeight: '700', color: '#1e40af', marginBottom: 6 },
    invoiceMatchSub: { fontSize: 12, color: '#1e3a8a', lineHeight: 18, marginBottom: 12 },
    invoiceMatchActions: { flexDirection: 'row', gap: 8 },
    invoiceBtnPrimary: { flex: 1, backgroundColor: '#2563eb', borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
    invoiceBtnPrimaryText: { fontSize: 13, fontWeight: '700', color: '#fff' },
    invoiceBtnSecondary: { flex: 1, backgroundColor: '#fff', borderRadius: 8, paddingVertical: 9, alignItems: 'center', borderWidth: 1, borderColor: '#bfdbfe' },
    invoiceBtnSecondaryText: { fontSize: 13, fontWeight: '600', color: '#1e40af' },

    // Invoice linked box (confirmed link in movement modal)
    invoiceLinkedBox: { marginTop: 16, backgroundColor: '#ecfdf5', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#a7f3d0' },
    invoiceLinkedTitle: { fontSize: 13, fontWeight: '700', color: '#065f46', marginBottom: 6 },
    invoiceLinkedSub: { fontSize: 12, color: '#064e3b', lineHeight: 18 },

    empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32 },
    emptyIcon: { fontSize: 36, marginBottom: 12 },
    emptyText: { fontSize: 16, fontWeight: '600', color: '#374151', marginBottom: 8 },
    emptySubtext: { fontSize: 13, color: '#9ca3af', textAlign: 'center', lineHeight: 20 },

    // Modal
    modalBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
    modalSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 34, maxHeight: '82%' },
    modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb', alignSelf: 'center', marginTop: 10, marginBottom: 4 },
    modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
    modalEmoji: { fontSize: 32 },
    modalBank: { fontSize: 13, color: '#6b7280', marginBottom: 2 },
    modalAmount: { fontSize: 26, fontWeight: '800' },
    modalClose: { fontSize: 18, color: '#9ca3af', paddingLeft: 8 },
    modalBody: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, gap: 4 },
    detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 16 },
    detailLabel: { fontSize: 13, color: '#9ca3af', flexShrink: 0 },
    detailValue: { fontSize: 13, color: '#111827', fontWeight: '500', flex: 1, textAlign: 'right' },
    snippetBox: { marginTop: 12, backgroundColor: '#f9fafb', borderRadius: 10, padding: 14 },
    snippetLabel: { fontSize: 11, fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    snippetText: { fontSize: 12, color: '#374151', lineHeight: 18 },

    // Manual badge
    badgeManual: { fontSize: 10, fontWeight: '600', color: '#5b21b6', backgroundColor: '#ede9fe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },

    // Delete manual movement button
    deleteManualBtn: { marginTop: 20, paddingVertical: 13, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#f3f4f6' },
    deleteManualBtnText: { fontSize: 13, color: '#ef4444', fontWeight: '600' },

    // FAB
    fab: { position: 'absolute', bottom: 32, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center', shadowColor: '#2563eb', shadowOpacity: 0.4, shadowRadius: 8, elevation: 6 },
    fabText: { fontSize: 30, color: '#fff', fontWeight: '300', lineHeight: 56, textAlign: 'center' },

    // Form modal
    formBody: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32, gap: 4 },
    formLabel: { fontSize: 11, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14 },
    formInput: { backgroundColor: '#f9fafb', borderRadius: 10, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: '#111827', marginTop: 6 },
    formDirRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
    dirBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, backgroundColor: '#f3f4f6', alignItems: 'center', borderWidth: 1, borderColor: '#e5e7eb' },
    dirBtnCreditActive: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
    dirBtnDebitActive: { backgroundColor: '#fff5f5', borderColor: '#fca5a5' },
    dirBtnText: { fontSize: 14, fontWeight: '600', color: '#6b7280' },
    dirBtnTextActive: { color: '#111827' },
    formChipsRow: { gap: 8, paddingVertical: 6 },
    formChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
    formChipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
    formChipText: { fontSize: 13, fontWeight: '500', color: '#374151' },
    formChipTextActive: { color: '#fff' },
    formDateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', borderRadius: 10, borderWidth: 1, borderColor: '#e5e7eb', marginTop: 6 },
    formDateArrow: { paddingHorizontal: 18, paddingVertical: 12 },
    formDateArrowText: { fontSize: 24, color: '#374151' },
    formDateLabel: { flex: 1, textAlign: 'center', fontSize: 14, color: '#111827', fontWeight: '500' },
    saveBtn: { marginTop: 24, backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
    saveBtnDisabled: { backgroundColor: '#93c5fd' },
    saveBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
})
