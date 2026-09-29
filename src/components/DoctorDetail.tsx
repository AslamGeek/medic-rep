import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Clock3,
  Edit3,
  MapPin,
  Package,
  Pill,
  Store,
} from 'lucide-react'
import type { Doctor, Product, Visit } from '../types'
import {
  buildLastVisitMap,
  doctorProductNames,
  formatDate,
  normalize,
  relativeVisitLabel,
} from '../utils'

interface DoctorDetailProps {
  doctor: Doctor
  products: Product[]
  visits: Visit[]
  onClose: () => void
  onEdit: () => void
  onLogVisit: (doctor: Doctor) => void
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  if (!value) return null
  return (
    <div className="detail-row">
      <div className="detail-row-icon">{icon}</div>
      <div><span>{label}</span><strong>{value}</strong></div>
    </div>
  )
}

export function DoctorDetail({ doctor, products, visits, onClose, onEdit, onLogVisit }: DoctorDetailProps) {
  const productNames = doctorProductNames(doctor, products)
  const lastVisitMap = buildLastVisitMap(visits)
  const lastVisit = lastVisitMap.get(doctor.id) ?? lastVisitMap.get(normalize(doctor.name))
  const doctorVisits = visits
    .filter((visit) =>
      visit.doctorIds.includes(doctor.id) ||
      visit.doctorLines.some((line) => normalize(line).includes(normalize(doctor.name))),
    )
    .slice(0, 5)

  return (
    <div className="full-screen-layer detail-layer" role="dialog" aria-modal="true" aria-label={`${doctor.name} details`}>
      <header className="modal-appbar">
        <button className="icon-button" onClick={onClose} aria-label="Back to directory"><ArrowLeft size={21} /></button>
        <div className="modal-title-grow"><p className="eyebrow">Doctor profile</p><h2>{doctor.name}</h2></div>
        <button className="save-icon-button subtle" onClick={onEdit}><Edit3 size={17} /><span>Edit</span></button>
      </header>

      <main className="detail-content">
        <section className={`profile-hero ${doctor.prescriber === 'Rx' ? 'rx' : ''}`}>
          <div className="avatar">{doctor.name.trim().charAt(0).toUpperCase() || 'D'}</div>
          <div className="profile-copy">
            <div className="doctor-title-row"><h1>{doctor.name}</h1><span className={`status-badge ${doctor.prescriber.toLowerCase()}`}>{doctor.prescriber}</span></div>
            <p>{doctor.specialties.join(' · ') || 'Specialty not specified'}</p>
            <div className="last-visit-pill"><CalendarDays size={14} /> {relativeVisitLabel(lastVisit)}</div>
          </div>
        </section>

        {doctor.prescriber === 'Rx' && productNames.length > 0 && (
          <section className="detail-card products-detail-card">
            <h3><Pill size={17} /> Prescribing</h3>
            <div className="product-detail-list">
              {productNames.map((name) => <span key={name}><Package size={14} />{name}</span>)}
            </div>
          </section>
        )}

        <section className="detail-card detail-grid">
          <DetailRow icon={<Building2 size={18} />} label="Hospital" value={doctor.hospital} />
          <DetailRow icon={<Store size={18} />} label="Pharmacy" value={doctor.pharmacy} />
          <DetailRow icon={<MapPin size={18} />} label="Area · Camp" value={[doctor.area, doctor.camp].filter(Boolean).join(' · ')} />
          <DetailRow icon={<Clock3 size={18} />} label="OP timing" value={doctor.opTiming} />
          <DetailRow icon={<CalendarDays size={18} />} label="Call schedule" value={doctor.callSchedule} />
          <DetailRow icon={<Store size={18} />} label="Stockist" value={doctor.stockist} />
        </section>

        {doctor.notes && <section className="detail-card notes-card"><h3>Notes</h3><p>{doctor.notes}</p></section>}

        <section className="detail-card">
          <div className="detail-section-heading"><h3>Recent calls</h3><span>{doctorVisits.length}</span></div>
          {doctorVisits.length ? (
            <div className="compact-history-list">
              {doctorVisits.map((visit) => (
                <div key={visit.localId}><strong>{formatDate(visit.date)}</strong><span>{visit.camp} · {visit.day}</span></div>
              ))}
            </div>
          ) : <p className="muted-inline">No logged visits yet.</p>}
        </section>
      </main>

      <div className="detail-sticky-action">
        <button className="primary-button" onClick={() => onLogVisit(doctor)}><CalendarDays size={18} /> Log visit</button>
      </div>
    </div>
  )
}
