"use client";

/**
 * The images step — and the seam the `uploads` module lands in.
 *
 * Upload itself belongs to `uploads` (tasks 4.1–4.7): the storage write, the
 * local technical gate, the vision call, the safety verdict and the flag for
 * admin review. That module is being built now, and none of it is reimplemented
 * here — a second upload path would be a second place for the safety gate to be
 * forgotten.
 *
 * So this step does the two things that are genuinely the route's:
 *
 *   • it shows what is already attached, read through `artworks.imagesFor`,
 *     which is the module that owns `artwork_images`; and
 *   • it states plainly that the picker is not here yet, rather than rendering
 *     a control that silently does nothing.
 *
 * WHAT `uploads` HAS TO DO TO MOUNT HERE: replace `<PendingUploader/>` with its
 * own client control. It should attach through `artworks.attachImage` and call
 * `artworks.setPrimaryImage` — the module's header is explicit that
 * `artwork_images` is its table and that setting the primary image is the
 * signal to recompute an embedding. Nothing else in this form needs to change:
 * the image count reaches the step model as a prop and the publish gate already
 * counts a missing image as a missing requirement.
 */
import { Badge } from "@/shared/ui";

export interface AttachedImage {
  readonly id: string;
  readonly altText: string | null;
  readonly isPrimary: boolean;
}

export interface ImageStepProps {
  readonly artworkId: string;
  readonly images: readonly AttachedImage[];
}

export function ImageStep({ artworkId, images }: ImageStepProps) {
  return (
    <div className="flex flex-col gap-5" data-artwork-id={artworkId}>
      {images.length === 0 ? (
        <p className="text-[15px] text-ink-soft">
          עוד לא צורפה תמונה. יצירה בלי תמונה אינה ניתנת לפרסום.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {images.map((image) => (
            <li key={image.id} className="flex items-center gap-3 border border-rule bg-card p-3">
              <span className="text-[15px]">{image.altText ?? "תמונת יצירה"}</span>
              {image.isPrimary ? <Badge variant="tag-selected">תמונה ראשית</Badge> : null}
            </li>
          ))}
        </ul>
      )}

      <PendingUploader />
    </div>
  );
}

function PendingUploader() {
  return (
    <div className="border border-dashed border-rule bg-paper-deep p-6">
      <p className="m-0 text-[15px] font-bold">העלאת תמונות</p>
      <p className="m-0 mt-2 text-[14px] font-light leading-relaxed text-ink-soft">
        בדיקת האיכות והתיוג האוטומטי עדיין בהקמה. עד שיהיו מוכנים, אפשר למלא את שאר הפרטים ולשמור
        טיוטה — היצירה תחכה לתמונה.
      </p>
    </div>
  );
}
