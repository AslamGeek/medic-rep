import { useMemo, useState } from 'react'
import {
  CalendarDays,
  CalendarOff,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  History,
  Search,
  Store,
  Users,
  X,
} from 'lucide-react'
import type { Doctor, MasterSettings, Visit, VisitKind } from '../types'
import {
  addDays,
  buildLastVisitMap,
  dayName,
  formatDate,
  isVisitStale,
  localDateString,
  normalize,
  relativeVisitLabel,
  stripVisitListNumber,
  unique,
  visitDoctorDisplayLine,
  visitLineForDoctor,
} from '../utils'

interface VisitsProps {
  doctors: Doctor[]
  visits: Visit[]
  settings: MasterSettings
  defaultCamp: string
  focusDoctorId: string | null
  onSave: (visit: Visit) => Promise<void>
}

function VisitHistory({ visits, camps, defaultCamp }: { visits: Visit[]; camps: string[]; defaultCamp: string }) {
  const [dateFilter, setDateFilter] = useState('')
  const [campFilter, setCampFilter] = useState(defaultCamp)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [monthVisibility, setMonthVisibility] = useState<Record<string, boolean>>({})
  const campOptions = unique([...camps, ...visits.map((visit) => visit.camp)])
    .sort((a, b) => a.localeCompare(b))
  const visibleVisits = visits
    .filter((visit) => !dateFilter || visit.date === dateFilter)
    .filter((visit) => !campFilter || visit.camp === campFilter)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  const groupedVisits = visibleVisits.reduce<Array<{ key: string; label: string; visits: Visit[] }>>(
    (groups, visit) => {
      const key = visit.date.slice(0, 7)
      const existing = groups.find((group) => group.key === key)
      if (existing) {
        existing.visits.push(visit)
      } else {
        groups.push({
          key,
          label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
            new Date(`${visit.date}T00:00:00`),
          ),
          visits: [visit],
        })
      }
      return groups
    },
    [],
  )

  return (
    <section className="visit-history-section">
      <div className="section-title-row history-title-row">
        <div><p className="eyebrow">Saved bundles</p><h2>Visit history</h2></div>
        <span className="history-count">{visibleVisits.length}</span>
      </div>

      <div className="history-filter-row">
        <label className="field">
          <span>Date</span>
          <input
            type="date"
            value={dateFilter}
            onChange={(event) => {
              setDateFilter(event.target.value)
              setExpandedId(null)
            }}
          />
        </label>
        <label className="field">
          <span>Camp</span>
          <select
            value={campFilter}
            onChange={(event) => {
              setCampFilter(event.target.value)
              setExpandedId(null)
            }}
          >
            <option value="">All camps</option>
            {campOptions.map((camp) => <option key={camp}>{camp}</option>)}
          </select>
        </label>
      </div>

      {dateFilter && (
        <button
          type="button"
          className="history-clear-date"
          onClick={() => {
            setDateFilter('')
            setExpandedId(null)
          }}
        >
          <X size={13} /> Show all dates
        </button>
      )}

      {visibleVisits.length ? (
        <div className="history-list">
          {groupedVisits.map((group, groupIndex) => {
            const monthOpen = dateFilter ? true : (monthVisibility[group.key] ?? groupIndex === 0)
            return (
              <section className="history-month" key={group.key}>
                <button
                  type="button"
                  className="history-month-toggle"
                  aria-expanded={monthOpen}
                  onClick={() => setMonthVisibility((current) => ({
                    ...current,
                    [group.key]: !monthOpen,
                  }))}
                >
                  <span>{group.label}</span>
                  <small>{group.visits.length} {group.visits.length === 1 ? 'bundle' : 'bundles'}</small>
                  {monthOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {monthOpen && (
                  <div className="history-month-bundles">
                    {group.visits.map((visit) => {
                      const expanded = expandedId === visit.localId
                      return (
                        <article
                          className={`history-card ${visit.kind !== 'Visit' ? 'no-visit' : ''}`}
                          key={visit.localId}
                        >
                          <button
                            type="button"
                            className="history-summary-button"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Show'} details for ${visit.camp} on ${formatDate(visit.date)}`}
                            onClick={() => setExpandedId(expanded ? null : visit.localId)}
                          >
                            <span className="history-date-block">
                              <strong>{new Date(`${visit.date}T00:00:00`).getDate()}</strong>
                              <span>{visit.day.slice(0, 3)}</span>
                            </span>
                            <span className="history-copy">
                              <span>
                                <strong>{visit.camp}</strong>
                                <i className={`sync-dot ${visit.syncState}`} title={visit.syncState} />
                              </span>
                              <small>
                                {visit.kind === 'Visit'
                                  ? `${visit.doctorCount} doctors · ${visit.pharmacyCount} pharmacies`
                                  : 'No visits'}
                              </small>
                            </span>
                            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>

                          {expanded && (
                            <div className="history-details">
                              {visit.kind === 'Visit' ? (
                                <>
                                  <div>
                                    <span><Users size={13} /> Doctors</span>
                                    <ol>
                                      {visit.doctorLines.map((doctor, index) => (
                                        <li key={`${doctor}-${index}`}>{visitDoctorDisplayLine(doctor)}</li>
                                      ))}
                                    </ol>
                                  </div>
                                  <div>
                                    <span><Store size={13} /> Pharmacies</span>
                                    {visit.pharmacyLines.length ? (
                                      <ol>
                                        {visit.pharmacyLines.map((pharmacy, index) => (
                                          <li key={`${pharmacy}-${index}`}>{stripVisitListNumber(pharmacy)}</li>
                                        ))}
                                      </ol>
                                    ) : <p>None linked</p>}
                                  </div>
                                </>
                              ) : <p>This date was saved as a no-visits day.</p>}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <div className="empty-card compact">
          <History size={24} />
          <h3>{dateFilter || campFilter ? 'No matching bundles' : 'No visits yet'}</h3>
          <p>
            {dateFilter || campFilter
              ? 'Choose another date or camp.'
              : 'Your saved bundles will appear here.'}
          </p>
        </div>
      )}
    </section>
  )
}

export function Visits({ doctors, visits, settings, defaultCamp, focusDoctorId, onSave }: VisitsProps) {
  const initialDoctor = doctors.find((doctor) => doctor.id === focusDoctorId)
  const [activeSection, setActiveSection] = useState<'log' | 'history'>('log')
  const [date, setDate] = useState(localDateString())
  const [camp, setCamp] = useState(initialDoctor?.camp ?? defaultCamp ?? settings.camps[0] ?? '')
  const [noVisits, setNoVisits] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>(
    initialDoctor ? [initialDoctor.id] : [],
  )
  const [query, setQuery] = useState('')
  const [specialty, setSpecialty] = useState('')
  const [callSchedule, setCallSchedule] = useState('Everyday')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const activeCamp = camp || settings.camps[0] || ''
  const isSunday = dayName(date) === 'Sunday'
  const effectiveKind: VisitKind = isSunday ? 'Sunday' : noVisits ? 'Holiday' : 'Visit'
  const campDoctors = doctors.filter((doctor) => doctor.camp === activeCamp)
  const specialties = unique(campDoctors.flatMap((doctor) => doctor.specialties))
  const callSchedules = unique(settings.callSchedules)
  const lastVisitMap = useMemo(() => buildLastVisitMap(visits, date), [visits, date])

  const filteredDoctors = campDoctors
    .filter((doctor) => !query || [doctor.name, doctor.hospital, doctor.pharmacy]
      .some((value) => normalize(value).includes(normalize(query))))
    .filter((doctor) => !specialty || doctor.specialties.includes(specialty))
    .filter((doctor) => !callSchedule || normalize(doctor.callSchedule) === normalize(callSchedule))
    .sort((a, b) => {
      const aDate = lastVisitMap.get(a.id) ?? lastVisitMap.get(normalize(a.name)) ?? ''
      const bDate = lastVisitMap.get(b.id) ?? lastVisitMap.get(normalize(b.name)) ?? ''
      if (aDate === bDate) return a.name.localeCompare(b.name)
      if (!aDate) return -1
      if (!bDate) return 1
      return aDate.localeCompare(bDate)
    })

  const selectedDoctors = selectedIds
    .map((id) => doctors.find((doctor) => doctor.id === id))
    .filter(Boolean) as Doctor[]
  const pharmacies = unique(selectedDoctors.map((doctor) => doctor.pharmacy))

  const toggleDoctor = (id: string) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id])
  }

  const selectVisible = () => {
    const visibleIds = filteredDoctors.map((doctor) => doctor.id)
    setSelectedIds((current) => unique([...current, ...visibleIds]))
  }

  const clearVisible = () => {
    const visibleIds = new Set(filteredDoctors.map((doctor) => doctor.id))
    setSelectedIds((current) => current.filter((id) => !visibleIds.has(id)))
  }

  const toggleNoVisits = () => {
    if (isSunday) return
    setNoVisits((current) => {
      if (!current) setSelectedIds([])
      return !current
    })
    setError('')
  }

  const saveVisit = async () => {
    setError('')
    if (!activeCamp) {
      setError('Select a camp first.')
      return
    }
    if (date < localDateString()) {
      setError('Past dates cannot be logged.')
      return
    }
    if (effectiveKind === 'Visit' && selectedDoctors.length === 0) {
      setError('Select at least one doctor.')
      return
    }

    const visit: Visit = {
      localId: crypto.randomUUID(),
      date,
      day: dayName(date),
      camp: activeCamp,
      kind: effectiveKind,
      doctorIds: effectiveKind === 'Visit' ? selectedDoctors.map((doctor) => doctor.id) : [],
      doctorCount: effectiveKind === 'Visit' ? selectedDoctors.length : 0,
      pharmacyCount: effectiveKind === 'Visit' ? pharmacies.length : 0,
      doctorLines: effectiveKind === 'Visit'
        ? selectedDoctors.map(visitLineForDoctor)
        : [`NO_VISIT:${effectiveKind}`],
      pharmacyLines: effectiveKind === 'Visit'
        ? pharmacies.map((pharmacy, index) => `${index + 1}. ${pharmacy}`)
        : [],
      createdAt: new Date().toISOString(),
      syncState: 'pending',
    }

    setSaving(true)
    try {
      await onSave(visit)
      setSelectedIds([])
      setDate(addDays(date, 1))
      setNoVisits(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the visit.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="page visits-page">
      <div className="segmented-control visits-section-switch" aria-label="Visits sections">
        <button
          type="button"
          className={activeSection === 'log' ? 'active' : ''}
          onClick={() => setActiveSection('log')}
        >
          <CalendarDays size={16} /> Log visits
        </button>
        <button
          type="button"
          className={activeSection === 'history' ? 'active' : ''}
          onClick={() => setActiveSection('history')}
        >
          <History size={16} /> Visit history
        </button>
      </div>

      {activeSection === 'history' ? (
        <VisitHistory visits={visits} camps={settings.camps} defaultCamp={defaultCamp} />
      ) : (
        <div className="visit-builder">
          <div className="section-title-row visit-title-row">
            <div><p className="eyebrow">Daily call plan</p><h2>Log visits</h2></div>
            <div className="date-day"><strong>{dayName(date)}</strong><span>{formatDate(date)}</span></div>
          </div>

          {error && (
            <div className="inline-alert error">
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button>
            </div>
          )}

          <div className="visit-basics">
            <label className="field">
              <span>Date</span>
              <input
                type="date"
                min={localDateString()}
                value={date}
                onChange={(event) => {
                  const nextDate = event.target.value || localDateString()
                  setDate(nextDate)
                  if (dayName(nextDate) === 'Sunday') setSelectedIds([])
                }}
              />
            </label>
            <label className="field">
              <span>Camp</span>
              <select
                value={activeCamp}
                onChange={(event) => {
                  setCamp(event.target.value)
                  setSelectedIds([])
                }}
              >
                <option value="">Select camp</option>
                {settings.camps.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <button
              type="button"
              className={`no-visits-toggle ${effectiveKind !== 'Visit' ? 'active' : ''}`}
              aria-pressed={effectiveKind !== 'Visit'}
              onClick={toggleNoVisits}
            >
              <CalendarOff size={18} />
              <span><strong>No visits</strong><small>{isSunday ? 'Sunday' : 'Holiday or leave'}</small></span>
            </button>
          </div>

          {effectiveKind !== 'Visit' && (
            <p className="no-visits-note">
              Doctor selection is disabled for this no-visits entry.
            </p>
          )}

          {effectiveKind === 'Visit' && (
            <>
              <div className="visit-filter-bar">
                <div className="search-box compact-search">
                  <Search size={17} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find doctor…"
                    aria-label="Search doctors for visit"
                  />
                  {query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={16} /></button>}
                </div>
                <select aria-label="Filter by call schedule" value={callSchedule} onChange={(event) => setCallSchedule(event.target.value)}>
                  <option value="">Any schedule</option>
                  {callSchedules.map((item) => <option key={item}>{item}</option>)}
                </select>
                <select aria-label="Filter by specialty" value={specialty} onChange={(event) => setSpecialty(event.target.value)}>
                  <option value="">All specialties</option>
                  {specialties.map((item) => <option key={item}>{item}</option>)}
                </select>
              </div>

              <div className="selection-toolbar">
                <span><Users size={15} /> {selectedIds.length} selected</span>
                <div><button onClick={selectVisible}>Select visible</button><button onClick={clearVisible}>Clear visible</button></div>
              </div>

              <div className="doctor-picker" role="listbox" aria-label="Doctors in selected camp">
                {filteredDoctors.length ? filteredDoctors.map((doctor) => {
                  const selected = selectedIds.includes(doctor.id)
                  const lastDate = lastVisitMap.get(doctor.id) ?? lastVisitMap.get(normalize(doctor.name))
                  return (
                    <button
                      className={`picker-doctor ${selected ? 'selected' : ''}`}
                      key={doctor.id}
                      onClick={() => toggleDoctor(doctor.id)}
                      role="option"
                      aria-selected={selected}
                    >
                      <span className="picker-check">{selected && <Check size={15} />}</span>
                      <div>
                        <strong>{doctor.name}</strong>
                        <p>{[doctor.specialties.join(', '), doctor.pharmacy].filter(Boolean).join(' · ')}</p>
                        <small className={isVisitStale(lastDate, date) ? 'stale' : ''}>
                          <Clock3 size={12} /> {relativeVisitLabel(lastDate, date)}
                        </small>
                      </div>
                    </button>
                  )
                }) : <div className="picker-empty">No doctors match this camp and filter.</div>}
              </div>

              <div className="visit-preview">
                <div className="preview-heading">
                  <div><p className="eyebrow">Live preview</p><h3>{selectedDoctors.length} doctors · {pharmacies.length} pharmacies</h3></div>
                  <span>{activeCamp || 'No camp'}</span>
                </div>
                {selectedDoctors.length ? (
                  <div className="preview-columns">
                    <div>
                      <span><Users size={14} /> Doctors</span>
                      <ol>{selectedDoctors.map((doctor) => <li key={doctor.id}>{doctor.name}</li>)}</ol>
                    </div>
                    <div>
                      <span><Store size={14} /> Pharmacies</span>
                      {pharmacies.length
                        ? <ol>{pharmacies.map((pharmacy) => <li key={pharmacy}>{pharmacy}</li>)}</ol>
                        : <p>None linked</p>}
                    </div>
                  </div>
                ) : <p className="muted-inline">Tap doctors above to build today’s bundle.</p>}
              </div>
            </>
          )}

          <button
            className="primary-button save-visit-button"
            onClick={saveVisit}
            disabled={saving || !activeCamp || (effectiveKind === 'Visit' && selectedIds.length === 0)}
          >
            <CalendarDays size={18} />
            {saving
              ? 'Saving locally…'
              : effectiveKind === 'Visit'
                ? 'Save visit bundle'
                : 'Save no-visits day'}
          </button>
        </div>
      )}
    </section>
  )
}
