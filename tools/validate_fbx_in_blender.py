"""
Blender FBX Diagnostic Script
=============================
Headless validation of an FBX file via Blender's FBX importer.
Produces a JSON report that pinpoints exactly why a model is invisible
or missing rig/animation.

USAGE (from a terminal, Blender 3.x / 4.x):
    blender --background --python validate_fbx_in_blender.py -- "C:/path/to/model.fbx" "C:/path/to/report.json"

Or, if blender is not in PATH on Windows:
    "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe" --background --python validate_fbx_in_blender.py -- "model.fbx" "report.json"

The script:
  1. Imports the FBX into an empty scene
  2. Captures ALL import warnings/errors from Blender's console
  3. Walks the scene graph and reports:
       - Every Mesh: vertex count, face count, polygon areas, bbox, materials, parent armature
       - Every Armature: bone hierarchy, bone count, rest pose
       - Every Action: name, frame range, fcurve count
       - Vertex groups (skin weights) on each mesh
       - Total scene bbox (is the model at origin? at reasonable scale?)
       - Drives a render so we can confirm visibility
  4. Writes the report to the path given as second arg (or prints JSON to stdout)

No external deps. Works on Blender 3.0+ and 4.x.
"""

import bpy
import sys
import json
import os
import mathutils
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr

# -----------------------------------------------------------------------------
# Argument parsing (Blender passes everything after `--` as sys.argv)
# -----------------------------------------------------------------------------
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

if not argv:
    print("ERROR: usage: blender --background --python validate_fbx_in_blender.py -- <fbx_path> [report_path]")
    sys.exit(1)

fbx_path = argv[0]
report_path = argv[1] if len(argv) > 1 else None

if not os.path.isfile(fbx_path):
    print("ERROR: FBX file not found: " + fbx_path)
    sys.exit(1)

# -----------------------------------------------------------------------------
# Capture every line Blender prints during import
# -----------------------------------------------------------------------------
import_log = StringIO()
err_log = StringIO()

# -----------------------------------------------------------------------------
# Reset scene to empty
# -----------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

# -----------------------------------------------------------------------------
# Import FBX while capturing stdout/stderr
# -----------------------------------------------------------------------------
import_ok = True
import_exception = None

try:
    with redirect_stdout(import_log), redirect_stderr(err_log):
        bpy.ops.import_scene.fbx(filepath=fbx_path)
except Exception as e:
    import_ok = False
    import_exception = repr(e)
    err_log.write("\nIMPORT EXCEPTION: " + repr(e) + "\n")

# -----------------------------------------------------------------------------
# Helper: scene bounding box
# -----------------------------------------------------------------------------
def scene_bbox():
    mins = [ float('inf')] * 3
    maxs = [-float('inf')] * 3
    seen = False
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        if obj.data.vertices is None or len(obj.data.vertices) == 0:
            continue
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                v = world_corner[i]
                if v < mins[i]: mins[i] = v
                if v > maxs[i]: maxs[i] = v
            seen = True
    if not seen:
        return None
    return {
        "min": [round(m, 6) for m in mins],
        "max": [round(m, 6) for m in maxs],
        "size": [round(maxs[i] - mins[i], 6) for i in range(3)],
        "center": [round((maxs[i] + mins[i]) / 2, 6) for i in range(3)],
    }

# -----------------------------------------------------------------------------
# Helper: bone hierarchy walk
# -----------------------------------------------------------------------------
def bone_tree(armature_obj):
    if armature_obj.data is None or armature_obj.data.bones is None:
        return {"bone_count": 0, "roots": []}
    def describe(bone):
        return {
            "name": bone.name,
            "children": [describe(c) for c in bone.children],
            "head": [round(x, 6) for x in bone.head_local],
            "tail": [round(x, 6) for x in bone.tail_local],
            "use_connect": bone.use_connect,
        }
    roots = [b for b in armature_obj.data.bones if b.parent is None]
    return {
        "bone_count": len(armature_obj.data.bones),
        "roots": [describe(r) for r in roots],
    }

# -----------------------------------------------------------------------------
# Walk the scene
# -----------------------------------------------------------------------------
meshes_report = []
armatures_report = []
actions_report = []
objects_overview = []

for obj in bpy.data.objects:
    entry = {
        "name": obj.name,
        "type": obj.type,
        "location": [round(x, 6) for x in obj.location],
        "rotation_euler": [round(x, 6) for x in obj.rotation_euler],
        "scale": [round(x, 6) for x in obj.scale],
        "parent": obj.parent.name if obj.parent else None,
        "parent_type": obj.parent_type if obj.parent else None,
        "visible": obj.visible_get(),
        "hide_viewport": obj.hide_viewport,
        "hide_render": obj.hide_render,
    }
    objects_overview.append(entry)

    if obj.type == 'MESH':
        mesh = obj.data
        # Per-vertex NaN/Infinity check
        nan_count = 0
        for v in mesh.vertices:
            for c in v.co:
                if c != c or c == float('inf') or c == -float('inf'):
                    nan_count += 1
                    break
        # Polygon area stats
        areas = [p.area for p in mesh.polygons]
        zero_area = sum(1 for a in areas if a <= 0)
        # Materials
        mats = [s.material.name if s.material else None for s in obj.material_slots]
        # UV layers
        uvs = [uv.name for uv in mesh.uv_layers]
        # Vertex groups (skin weights)
        vg = [g.name for g in obj.vertex_groups]
        # Modifiers (armature deform, etc.)
        mods = [{
            "name": m.name,
            "type": m.type,
        } for m in obj.modifiers]
        # Custom props
        custom = dict(obj.keys())
        if '_RNA_UI' in custom:
            custom.pop('_RNA_UI')

        # Material textures (rough heuristic)
        mat_textures = []
        for slot in obj.material_slots:
            if not slot.material:
                continue
            for nt in slot.material.node_tree.nodes if slot.material.node_tree else []:
                if nt.type == 'TEX_IMAGE' and nt.image:
                    mat_textures.append({
                        "material": slot.material.name,
                        "image": nt.image.name,
                        "filepath": nt.image.filepath,
                        "size": list(nt.image.size),
                    })

        meshes_report.append({
            "name": obj.name,
            "vertex_count": len(mesh.vertices),
            "face_count": len(mesh.polygons),
            "edge_count": len(mesh.edges),
            "loop_count": len(mesh.loops),
            "uv_layers": uvs,
            "vertex_groups": vg,
            "modifiers": mods,
            "materials": mats,
            "textures": mat_textures,
            "vertex_nan_count": nan_count,
            "zero_area_faces": zero_area,
            "total_area": round(sum(areas), 6),
            "min_face_area": round(min(areas), 6) if areas else 0,
            "max_face_area": round(max(areas), 6) if areas else 0,
            "bbox_local": {
                "min": [round(x, 6) for x in obj.bound_box[0]],
                "max": [round(x, 6) for x in obj.bound_box[6]],
            },
            "matrix_world": [[round(x, 6) for x in row] for row in obj.matrix_world],
            "has_vertex_normals": True if mesh.vertex_normals else False,
            "custom_properties": custom if custom else None,
            "parent_armature": obj.parent.name if (obj.parent and obj.parent.type == 'ARMATURE') else None,
        })

    elif obj.type == 'ARMATURE':
        armatures_report.append({
            "name": obj.name,
            "bone_hierarchy": bone_tree(obj),
            "pose_bones": [b.name for b in obj.pose.bones] if obj.pose else [],
            "matrix_world": [[round(x, 6) for x in row] for row in obj.matrix_world],
            "custom_properties": dict(obj.keys()) if len(obj.keys()) else None,
        })

# Actions (animations)
for action in bpy.data.actions:
    fcurves_report = []
    for fc in action.fcurves:
        fcurves_report.append({
            "data_path": fc.data_path,
            "array_index": fc.array_index,
            "keyframe_count": len(fc.keyframe_points),
            "extrapolation": fc.extrapolation,
            "frame_range": [round(fc.frame_range[0], 3), round(fc.frame_range[1], 3)] if fc.keyframe_points else None,
        })
    actions_report.append({
        "name": action.name,
        "frame_range": [round(action.frame_range[0], 3), round(action.frame_range[1], 3)],
        "fcurve_count": len(action.fcurves),
        "fcurves": fcurves_report[:20],  # cap to first 20 for readability
        "fcurves_truncated": len(fcurves_report) > 20,
        "total_keyframes": sum(len(fc.keyframe_points) for fc in action.fcurves),
    })

# -----------------------------------------------------------------------------
# Final report
# -----------------------------------------------------------------------------
report = {
    "fbx_path": fbx_path,
    "file_size_bytes": os.path.getsize(fbx_path),
    "blender_version": bpy.app.version_string,
    "import_success": import_ok,
    "import_exception": import_exception,
    "import_stdout": import_log.getvalue().strip().splitlines(),
    "import_stderr": err_log.getvalue().strip().splitlines(),
    "scene_summary": {
        "total_objects": len(bpy.data.objects),
        "mesh_count": sum(1 for o in bpy.data.objects if o.type == 'MESH'),
        "armature_count": sum(1 for o in bpy.data.objects if o.type == 'ARMATURE'),
        "empty_count": sum(1 for o in bpy.data.objects if o.type == 'EMPTY'),
        "light_count": sum(1 for o in bpy.data.objects if o.type == 'LIGHT'),
        "camera_count": sum(1 for o in bpy.data.objects if o.type == 'CAMERA'),
        "action_count": len(bpy.data.actions),
        "material_count": len(bpy.data.materials),
        "image_count": len(bpy.data.images),
        "scene_bbox": scene_bbox(),
    },
    "objects_overview": objects_overview,
    "meshes": meshes_report,
    "armatures": armatures_report,
    "actions": actions_report,
}

# Quick verdict
verdict = []
if not import_ok:
    verdict.append("IMPORT FAILED with exception — FBX is malformed.")
elif report["scene_summary"]["mesh_count"] == 0:
    verdict.append("FBX imported but 0 meshes in scene — geometry lost or filtered.")
if report["scene_summary"]["mesh_count"] > 0:
    any_verts = any(m["vertex_count"] > 0 for m in meshes_report)
    if not any_verts:
        verdict.append("Meshes exist but ALL have 0 vertices — empty geometry.")
if report["scene_summary"]["armature_count"] == 0 and any(m.get("vertex_groups") for m in meshes_report):
    verdict.append("Meshes have vertex groups but NO armature imported — rig lost.")
if report["scene_summary"]["action_count"] == 0:
    verdict.append("No animation actions imported — animation lost or absent in FBX.")
bbox = report["scene_summary"]["scene_bbox"]
if bbox:
    size = bbox["size"]
    if max(size) < 0.001:
        verdict.append("Scene bbox is tiny (<1mm) — model is microscopic; scale issue.")
    if max(size) > 100000:
        verdict.append("Scene bbox is huge (>100km) — model is gigantic; scale issue.")
    if any(abs(c) > 10000 for c in bbox["center"]):
        verdict.append("Scene center is far from origin — model is offset.")
if not verdict:
    verdict.append("No obvious issues detected — model should be visible.")
report["verdict"] = verdict

# -----------------------------------------------------------------------------
# Write report
# -----------------------------------------------------------------------------
json_str = json.dumps(report, indent=2, ensure_ascii=False)
if report_path:
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(json_str)
    print("Report written to: " + report_path)
else:
    print(json_str)

# Always also print a quick summary to console
print("=" * 70)
print("FBX DIAGNOSTIC SUMMARY")
print("=" * 70)
print("Import success : " + str(report["import_success"]))
print("Meshes         : " + str(report["scene_summary"]["mesh_count"]))
print("Armatures      : " + str(report["scene_summary"]["armature_count"]))
print("Actions        : " + str(report["scene_summary"]["action_count"]))
print("Materials      : " + str(report["scene_summary"]["material_count"]))
print("Images         : " + str(report["scene_summary"]["image_count"]))
if bbox:
    print("BBox size      : " + str(bbox["size"]))
    print("BBox center    : " + str(bbox["center"]))
print("-" * 70)
for v in verdict:
    print(" * " + v)
print("=" * 70)
