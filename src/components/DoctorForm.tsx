import { useState, type FormEvent } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  Check,
  Clock3,
  MapPin,
  Package,
  Save,
  Stethoscope,
  X,
} from 'lucide-react'
import type { CallWindow, Doctor, MasterData, Prescriber } from '../types'
import { WEEKDAYS, validateAvailability } from '../../shared/availability.js'
import { generateDoctorId, normalize, productLabel } from '../utils'
import { productIdsFromCell, unresolvedProductReferences } from '../../shared/products.js'

interface DoctorFormProps {
  doctor: Doctor | null
  doctors: Doctor[]
  master: MasterData
  onClose: () => void
  onSave: (doctor: Doctor) => Promise<void>
}

function emptyDoctor(): Doctor {
  return {
    id: '',
    name: '',
    specialties: [],
    hospital: '',
    pharmacy: '',
    area: '',
    camp: '',
    potential: '',
    stockist: '',
    prescriber: 'NRx',
    opTiming: '',
    callSchedule: '',
    prescribingProductIds: [],
    notes: '',
    updatedAt: new Date().toISOString(),
    syncState: 'pending',
  }
}

function MasterSelect({
  label,
  value,
  values,
  required,
  onChange,
}: {
  label: string
  value: string
  values: string[]
  required?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="field">
      <span>{label}{required && <b aria-hidden="true"> *</b>}</span>
      <select value={value} required={required} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select {label.toLowerCase()}</option>
        {values.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  )
}

export function DoctorForm({ doctor, doctors, master, onClose, onSave }: DoctorFormProps) {
  const [form, setForm] = useState<Doctor>(() => doctor
    ? { ...structuredClone(doctor), prescribingProductIds: productIdsFromCell(doctor.prescribingProductIds, master.products) }
    : emptyDoctor())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const updateWindow = (index: number, changes: Partial<CallWindow>) => {
    set('availability', (form.availability || []).map((window, position) => position === index ? { ...window, ...changes } : window))
  }

  const set = <K extends keyof Doctor>(key: K, value: Doctor[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const toggleList = (
    key: 'specialties' | 'prescribingProductIds',
    value: string,
  ) => {
    const current = key === 'prescribingProductIds' ? productIdsFromCell(form[key], master.products) : form[key]
    set(key, current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!form.name.trim() || !form.area || !form.camp) {
      setError('Name, area and camp are required.')
      return
    }
    try {
      if (form.availability !== undefined) validateAvailability(form.availability)
    } catch (availabilityError) {
      setError(availabilityError instanceof Error ? availabilityError.message : 'Review call availability.')
      return
    }
    const duplicate = doctors.find(
      (item) =>
        item.id !== form.id &&
        normalize(item.name) === normalize(form.name) &&
        normalize(item.hospital) === normalize(form.hospital),
    )
    if (duplicate) {
      setError(`This doctor already exists as ${duplicate.id}.`)
      return
    }

    const references = form.prescriber === 'Rx' ? form.prescribingProductIds : []
    const unresolved = unresolvedProductReferences(references, master.products)
    if (unresolved.length) {
      setError(`Review prescribing products: ${unresolved.join(', ')}. Remove or reselect these before saving.`)
      return
    }

    const payload: Doctor = {
      ...form,
      id: form.id || generateDoctorId(form.camp, doctors),
      isNewRecord: !doctor,
      name: form.name.trim(),
      prescribingProductIds: productIdsFromCell(references, master.products),
      updatedAt: new Date().toISOString(),
      syncState: 'pending',
    }
    setSaving(true)
    try {
      await onSave(payload)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the doctor.')
      setSaving(false)
    }
  }

  const missingMasters = !master.settings.areas.length || !master.settings.camps.length
  const unresolvedProducts = unresolvedProductReferences(form.prescribingProductIds, master.products)
  const selectedProductIds = productIdsFromCell(form.prescribingProductIds, master.products)

  return (
    <div className="full-screen-layer" role="dialog" aria-modal="true" aria-label={doctor ? 'Edit doctor' : 'Add doctor'}>
      <header className="modal-appbar">
        <button className="icon-button" onClick={onClose} aria-label="Close doctor form">
          <ArrowLeft size={21} />
        </button>
        <div>
          <p className="eyebrow">Directory</p>
          <h2>{doctor ? 'Edit doctor' : 'Add doctor'}</h2>
        </div>
        <button className="save-icon-button" form="doctor-form" type="submit" disabled={saving || missingMasters}>
          <Save size={18} />
          <span>{saving ? 'Saving' : 'Save'}</span>
        </button>
      </header>

      <form id="doctor-form" className="doctor-form" onSubmit={submit}>
        {missingMasters && (
          <div className="inline-alert warning">
            <AlertCircle size={18} />
            <div>
              <strong>Master data is not ready</strong>
              <p>Add Areas and Camps to the Settings sheet, then reopen the app online.</p>
            </div>
          </div>
        )}
        {error && (
          <div className="inline-alert error">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button>
          </div>
        )}

        <section className="form-card essential-card">
          <div className="form-card-title"><Stethoscope size={18} /> Essentials</div>
          <label className="field">
            <span>Doctor name <b aria-hidden="true">*</b></span>
            <input
              autoFocus={!doctor}
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="Full name"
              maxLength={120}
              required
            />
          </label>
          <div className="two-column-fields">
            <MasterSelect label="Area" value={form.area} values={master.settings.areas} required onChange={(value) => set('area', value)} />
            <MasterSelect label="Camp" value={form.camp} values={master.settings.camps} required onChange={(value) => set('camp', value)} />
          </div>
        </section>

        <section className="form-card">
          <div className="form-card-title"><Stethoscope size={18} /> Specialties</div>
          <div className="chip-row roomy">
            {master.settings.specialties.map((specialty) => (
              <button
                type="button"
                className={`choice-chip ${form.specialties.includes(specialty) ? 'selected' : ''}`}
                key={specialty}
                onClick={() => toggleList('specialties', specialty)}
              >
                {form.specialties.includes(specialty) && <Check size={13} />}
                {specialty}
              </button>
            ))}
            {!master.settings.specialties.length && <p className="muted-inline">No specialties in Settings.</p>}
          </div>
        </section>

        <section className="form-card">
          <div className="form-card-title"><MapPin size={18} /> Location</div>
          <label className="field"><span>Hospital</span><input value={form.hospital} onChange={(event) => set('hospital', event.target.value)} placeholder="Optional" maxLength={150} /></label>
          <label className="field"><span>Linked pharmacy</span><input value={form.pharmacy} onChange={(event) => set('pharmacy', event.target.value)} placeholder="Used automatically in visits" maxLength={150} /></label>
        </section>

        <section className="form-card">
          <div className="form-card-title"><Building2 size={18} /> Classification</div>
          <div className="segmented-control" aria-label="Prescriber status">
            {(['NRx', 'Rx'] as Prescriber[]).map((value) => (
              <button type="button" className={form.prescriber === value ? 'active' : ''} key={value} onClick={() => set('prescriber', value)}>{value}</button>
            ))}
          </div>
          <div className="two-column-fields">
            <MasterSelect label="Potential" value={form.potential} values={master.settings.potentials} onChange={(value) => set('potential', value)} />
            <MasterSelect label="Stockist" value={form.stockist} values={master.settings.stockists} onChange={(value) => set('stockist', value)} />
          </div>
        </section>

        {form.prescriber === 'Rx' && (
          <section className="form-card rx-product-card">
            <div className="form-card-title"><Package size={18} /> Prescribing products</div>
            {unresolvedProducts.length > 0 && (
              <div role="alert">
                <p className="muted-inline">These saved products could not be matched. Remove them below and select the correct products from the list.</p>
                <div className="chip-row roomy">
                  {unresolvedProducts.map((reference) => (
                    <button type="button" className="choice-chip" key={reference}
                      onClick={() => toggleList('prescribingProductIds', reference)}
                      aria-label={`Remove unmatched product ${reference}`}>
                      <X size={13} /> {reference}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="chip-row roomy">
              {master.products.map((product) => (
                <button
                  type="button"
                  className={`choice-chip ${selectedProductIds.includes(product.prodId) ? 'selected' : ''}`}
                  key={product.prodId}
                  onClick={() => toggleList('prescribingProductIds', product.prodId)}
                >
                  {selectedProductIds.includes(product.prodId) && <Check size={13} />}
                  {productLabel(product)}
                </button>
              ))}
              {!master.products.length && <p className="muted-inline">No products in the Products sheet.</p>}
            </div>
          </section>
        )}

        <section className="form-card">
          <div className="form-card-title"><Clock3 size={18} /> Availability</div>
          <div className="two-column-fields">
            <MasterSelect label="OP timing" value={form.opTiming} values={master.settings.opTimings} onChange={(value) => set('opTiming', value)} />
            <MasterSelect label="Call schedule" value={form.callSchedule} values={master.settings.callSchedules} onChange={(value) => set('callSchedule', value)} />
          </div>
          <p className="muted-inline">Set when the doctor accepts representative calls. These windows take priority over the general OP timing in Visit now.</p>
          {(form.availability || []).map((window, index) => (
            <fieldset className="call-window" key={index}>
              <legend>Call window {index + 1}</legend>
              <div className="chip-row" role="group" aria-label={`Weekdays for window ${index + 1}`}>
                {[...WEEKDAYS.slice(1), WEEKDAYS[0]].map(day => (
                  <button type="button" key={day} className={`choice-chip ${window.days.includes(day) ? 'selected' : ''}`}
                    aria-pressed={window.days.includes(day)}
                    onClick={() => updateWindow(index, { days: window.days.includes(day) ? window.days.filter(value => value !== day) : [...window.days, day] })}>{day}</button>
                ))}
              </div>
              <div className="two-column-fields">
                <label className="field"><span>Available from</span><input aria-label={`Available from, window ${index + 1}`} type="time" required value={window.from} onChange={event => updateWindow(index, { from: event.target.value })} /></label>
                <label className="field"><span>Available until</span><input aria-label={`Available until, window ${index + 1}`} type="time" value={window.until} onChange={event => updateWindow(index, { until: event.target.value })} /></label>
              </div>
              <p className="muted-inline">Leave the end blank only if the closing time is unknown. Use separate windows for different days or morning/evening calls.</p>
              <label className="field"><span>Timing note</span><input aria-label={`Timing note, window ${index + 1}`} value={window.notes} maxLength={200} placeholder="For example: meet after the last patient" onChange={event => updateWindow(index, { notes: event.target.value })} /></label>
              <button type="button" className="choice-chip" aria-label={`Remove window ${index + 1}`} onClick={() => set('availability', (form.availability || []).filter((_, position) => position !== index))}>Remove window</button>
            </fieldset>
          ))}
          <button type="button" className="choice-chip" disabled={(form.availability || []).length >= 14}
            onClick={() => set('availability', [...(form.availability || []), { days: [...WEEKDAYS], from: '', until: '', notes: '' }])}>Add call window</button>
        </section>

        <section className="form-card">
          <label className="field"><span>Notes</span><textarea value={form.notes} onChange={(event) => set('notes', event.target.value)} placeholder="Anything useful for the next call" rows={4} maxLength={500} /></label>
        </section>

        <button className="primary-button form-submit" type="submit" disabled={saving || missingMasters}>
          <Save size={18} /> {saving ? 'Saving locally…' : 'Save doctor'}
        </button>
      </form>
    </div>
  )
}
