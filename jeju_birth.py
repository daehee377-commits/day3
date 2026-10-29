"""Jeju Island birth animation (Blender, Cycles).

Run:
  blender -b -P jeju_birth.py -- --dem jeju_dem.tif --out jeju_birth.mp4
Single test frame:
  blender -b -P jeju_birth.py -- --dem jeju_dem.tif --still 300 --preview --out test.png
"""
import argparse
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser()
    p.add_argument("--dem", default="", help="DEM image (GeoTIFF / 16-bit PNG). Empty = synthetic Jeju-like terrain")
    p.add_argument("--dem-max-m", type=float, default=1950.0,
                   help="elevation (m) of pixel value 1.0 when the DEM is normalized to 0..1")
    p.add_argument("--width-km", type=float, default=73.0, help="east-west extent of the DEM in km")
    p.add_argument("--exag", type=float, default=3.0, help="vertical exaggeration")
    p.add_argument("--seconds", type=float, default=20.0)
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--res", default="1920x1080")
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--wave-scale", type=float, default=0.35)
    p.add_argument("--sun-elev", type=float, default=11.0, help="sun elevation in degrees")
    p.add_argument("--out", default=os.path.join(here, "jeju_birth.mp4"))
    p.add_argument("--still", type=int, default=0, help="render only this frame as PNG")
    p.add_argument("--preview", action="store_true", help="half resolution, few samples")
    p.add_argument("--save-blend", default="")
    return p.parse_args(argv)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


# ---------------------------------------------------------------- DEM

def load_dem(path, max_m, target=700):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    ch = img.channels
    px = np.empty(w * h * ch, dtype=np.float32)
    img.pixels.foreach_get(px)
    arr = px.reshape(h, w, ch)[:, :, 0].astype(np.float64)
    if arr.max() <= 1.0 + 1e-6:
        arr = arr * max_m
    arr[arr < 1.0] = 0.0  # nodata / sea
    s = max(1, int(math.ceil(max(w, h) / target)))
    arr = arr[: h // s * s, : w // s * s].reshape(h // s, s, w // s, s).mean(axis=(1, 3))
    return arr


def synth_dem(nx=640, ny=360):
    rng = np.random.default_rng(7)
    X, Y = np.meshgrid(np.linspace(-36.5, 36.5, nx), np.linspace(-20.5, 20.5, ny))
    r = np.sqrt((X / 33.0) ** 2 + (Y / 14.5) ** 2)
    r = r * (1.0 + 0.04 * np.sin(X * 0.45) + 0.03 * np.cos(Y * 0.8))
    mask = r < 1.0
    rh = np.hypot(X + 4.0, Y - 0.5)
    cone = 1950.0 * np.exp(-((rh / 7.0) ** 1.5))
    shield = 450.0 * np.clip(1.0 - r, 0, 1) ** 0.7
    h = np.maximum(cone, shield)
    for _ in range(120):
        cx, cy = rng.uniform(-28, 28), rng.uniform(-10, 10)
        h = h + rng.uniform(60, 250) * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / rng.uniform(0.3, 1.2))
    return np.where(mask, h, 0.0)


# ---------------------------------------------------------------- terrain

class Terrain:
    def __init__(self, elev_m, width_km, exag):
        ny, nx = elev_m.shape
        d = width_km / (nx - 1)
        xs = (np.arange(nx) - (nx - 1) / 2) * d
        ys = (np.arange(ny) - (ny - 1) / 2) * d
        X, Y = np.meshgrid(xs, ys)
        self.n = nx * ny
        self.land = (elev_m > 1.0).ravel()
        self.elev_m = elev_m.ravel()
        r = np.sqrt((X / (xs[-1] + 1e-9)) ** 2 + (Y / (ys[-1] + 1e-9)) ** 2)
        seabed = -0.08 - 1.6 * np.clip((r - 0.35) / 0.8, 0, 1) ** 1.5
        self.z0 = seabed.ravel()
        self.zf = np.where(self.land, self.elev_m / 1000.0 * exag, self.z0)
        peak = np.argmax(self.elev_m)
        dist = np.hypot(X.ravel() - X.ravel()[peak], Y.ravel() - Y.ravel()[peak])
        dmax = dist[self.land].max() if self.land.any() else 1.0
        self.start = 0.04 + 0.40 * dist / dmax
        self.dur = 0.38
        self.co = np.zeros((self.n, 3), dtype=np.float32)
        self.co[:, 0] = X.ravel()
        self.co[:, 1] = Y.ravel()
        self.co[:, 2] = self.z0

        mesh = bpy.data.meshes.new("Jeju")
        i, j = np.meshgrid(np.arange(nx - 1), np.arange(ny - 1))
        a = (j * nx + i).ravel()
        faces = np.stack([a, a + 1, a + nx + 1, a + nx], axis=1)
        mesh.from_pydata(self.co.tolist(), [], faces.tolist())
        mesh.attributes.new("heat", "FLOAT", "POINT")
        mesh.attributes.new("veg", "FLOAT", "POINT")
        self.mesh = mesh
        self.obj = bpy.data.objects.new("Jeju", mesh)
        bpy.context.scene.collection.objects.link(self.obj)
        for poly in mesh.polygons:
            poly.use_smooth = True

    def apply(self, t):
        u = (t - self.start) / self.dur
        e = smoothstep(u)
        z = np.where(self.land, self.z0 + (self.zf - self.z0) * e, self.zf)
        heat = np.where(u < 0, 0.0, np.where(u <= 1.0, 1.0, np.exp(-(u - 1.0) * 5.0)))
        heat = np.where(self.land, heat, 0.0)
        g = float(np.clip((t - 0.72) / 0.2, 0.0, 1.0))
        veg = g * (1.0 - np.clip(self.elev_m / 1700.0, 0, 1)) ** 0.6
        veg = np.where(self.land, veg, 0.0)
        self.co[:, 2] = z
        self.mesh.vertices.foreach_set("co", self.co.ravel())
        self.mesh.attributes["heat"].data.foreach_set("value", heat.astype(np.float32))
        self.mesh.attributes["veg"].data.foreach_set("value", veg.astype(np.float32))
        self.mesh.update()


# ---------------------------------------------------------------- materials

def sock(node, *names):
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    raise KeyError(names)


def terrain_material():
    m = bpy.data.materials.new("Terrain")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out = N.new("ShaderNodeOutputMaterial")
    bsdf = N.new("ShaderNodeBsdfPrincipled")
    heat = N.new("ShaderNodeAttribute"); heat.attribute_name = "heat"
    veg = N.new("ShaderNodeAttribute"); veg.attribute_name = "veg"
    coord = N.new("ShaderNodeTexCoord")
    noise = N.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 3.0
    noise.inputs["Detail"].default_value = 8.0
    rock = N.new("ShaderNodeMixRGB")
    rock.inputs[1].default_value = (0.025, 0.022, 0.02, 1)
    rock.inputs[2].default_value = (0.09, 0.075, 0.06, 1)
    green = N.new("ShaderNodeMixRGB")
    green.inputs[2].default_value = (0.05, 0.17, 0.03, 1)
    L.new(coord.outputs["Object"], noise.inputs["Vector"])
    L.new(noise.outputs["Fac"], rock.inputs[0])
    L.new(rock.outputs["Color"], green.inputs[1])
    L.new(veg.outputs["Fac"], green.inputs[0])
    L.new(green.outputs["Color"], sock(bsdf, "Base Color"))
    sock(bsdf, "Roughness").default_value = 0.85
    lava = N.new("ShaderNodeEmission")
    lava.inputs["Color"].default_value = (1.0, 0.22, 0.02, 1)
    mult = N.new("ShaderNodeMath"); mult.operation = "MULTIPLY"; mult.inputs[1].default_value = 12.0
    L.new(heat.outputs["Fac"], mult.inputs[0])
    L.new(mult.outputs["Value"], lava.inputs["Strength"])
    add = N.new("ShaderNodeAddShader")
    L.new(bsdf.outputs["BSDF"], add.inputs[0])
    L.new(lava.outputs["Emission"], add.inputs[1])
    L.new(add.outputs["Shader"], out.inputs["Surface"])
    return m


def water_material(tint=(0.02, 0.22, 0.32, 1.0), ripple=True):
    m = bpy.data.materials.new("Water")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out = N.new("ShaderNodeOutputMaterial")
    bsdf = N.new("ShaderNodeBsdfPrincipled")
    sock(bsdf, "Base Color").default_value = tint
    sock(bsdf, "Roughness").default_value = 0.025
    sock(bsdf, "IOR").default_value = 1.333
    sock(bsdf, "Transmission Weight", "Transmission").default_value = 0.85
    L.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    if ripple:
        coord = N.new("ShaderNodeTexCoord")
        noise = N.new("ShaderNodeTexNoise")
        noise.noise_dimensions = "4D"
        noise.inputs["Scale"].default_value = 1.6
        noise.inputs["Detail"].default_value = 6.0
        bump = N.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.12
        L.new(coord.outputs["Object"], noise.inputs["Vector"])
        L.new(noise.outputs["Fac"], bump.inputs["Height"])
        L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        m["noise_node"] = noise.name
    return m


def emission_material(color, strength):
    m = bpy.data.materials.new("Sun")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


# ---------------------------------------------------------------- scene

def build_ocean(wave_scale):
    bpy.ops.mesh.primitive_plane_add(size=1)
    ob = bpy.context.active_object
    ob.name = "Ocean"
    mod = ob.modifiers.new("Ocean", "OCEAN")
    mod.geometry_mode = "GENERATE"
    mod.repeat_x = 6
    mod.repeat_y = 6
    mod.spatial_size = 100
    mod.resolution = 14
    mod.wave_scale = wave_scale
    mod.choppiness = 1.2
    mod.wind_velocity = 12.0
    mod.use_normals = True
    mod.random_seed = 3
    ob.scale = (0.6, 0.6, 0.6)
    mat = water_material()
    ob.data.materials.append(mat)
    bpy.context.view_layer.update()
    ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
    pts = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    ob.location.x -= sum(p.x for p in pts) / 8
    ob.location.y -= sum(p.y for p in pts) / 8
    return ob, mod, mat


def build_far_water(mat):
    bpy.ops.mesh.primitive_plane_add(size=8000, location=(0, 0, -0.04))
    far = bpy.context.active_object
    far.name = "FarWater"
    far.data.materials.append(mat)
    bpy.ops.mesh.primitive_plane_add(size=8000, location=(0, 0, -3.5))
    floor = bpy.context.active_object
    floor.name = "SeaFloor"
    floor.data.materials.append(emission_material((0.0, 0.03, 0.05, 1), 0.2))


def build_sky_and_sun(sun_elev_deg):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    for kind in ("NISHITA", "MULTIPLE_SCATTERING"):
        try:
            sky.sky_type = kind
            break
        except TypeError:
            continue
    try:
        sky.sun_disc = False
    except AttributeError:
        pass
    sky.sun_elevation = math.radians(sun_elev_deg)
    sky.sun_rotation = 0.0
    nt.links.new(sky.outputs[0], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world

    el = math.radians(sun_elev_deg)
    to_sun = Vector((0.0, math.cos(el), math.sin(el)))  # sun sits in the north, behind the island

    light = bpy.data.lights.new("Sun", "SUN")
    light.energy = 4.0
    light.angle = math.radians(1.5)
    light.color = (1.0, 0.82, 0.62)
    lob = bpy.data.objects.new("Sun", light)
    lob.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(lob)

    dist = 1800.0
    bpy.ops.mesh.primitive_uv_sphere_add(radius=dist * math.tan(math.radians(1.6)), location=to_sun * dist)
    disc = bpy.context.active_object
    disc.name = "SunDisc"
    disc.data.materials.append(emission_material((1.0, 0.85, 0.6, 1), 2500.0))
    disc.visible_diffuse = False
    disc.visible_shadow = False
    disc.visible_volume_scatter = False


def build_camera():
    scene = bpy.context.scene
    orbit = bpy.data.objects.new("Orbit", None)
    target = bpy.data.objects.new("Target", None)
    target.location = (0, 0, 1.5)
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 24
    cam_data.clip_end = 6000
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.parent = orbit
    cam.location = (0, -70, 10)
    con = cam.constraints.new("TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"
    for o in (orbit, target, cam):
        scene.collection.objects.link(o)
    scene.camera = cam
    return orbit, cam


def setup_render(a):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    w, h = (int(v) for v in a.res.lower().split("x"))
    pct = 50 if a.preview else 100
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = pct
    scene.cycles.samples = 24 if a.preview else a.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 12
    scene.cycles.glossy_bounces = 8
    scene.cycles.sample_clamp_indirect = 6.0
    try:
        scene.view_settings.view_transform = "AgX"
    except TypeError:
        scene.view_settings.view_transform = "Filmic"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type != "CPU" for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = True
                    scene.cycles.device = "GPU"
                    break
            except Exception:
                continue
    except Exception:
        pass
    scene.render.fps = a.fps
    scene.frame_start = 1
    scene.frame_end = max(2, int(a.seconds * a.fps))
    if a.still:
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = a.out
    else:
        scene.render.image_settings.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "HIGH"
        scene.render.filepath = a.out
    try:  # soft glow around the sun; node API differs between Blender versions
        scene.use_nodes = True
        nt = scene.node_tree
        nt.nodes.clear()
        rl = nt.nodes.new("CompositorNodeRLayers")
        gl = nt.nodes.new("CompositorNodeGlare")
        for kind in ("FOG_GLOW", "BLOOM"):
            try:
                gl.glare_type = kind
                break
            except TypeError:
                continue
        co = nt.nodes.new("CompositorNodeComposite")
        nt.links.new(rl.outputs["Image"], gl.inputs["Image"])
        nt.links.new(gl.outputs["Image"], co.inputs["Image"])
    except Exception as exc:
        print("glare skipped:", exc)


def main():
    a = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    if a.dem:
        elev = load_dem(a.dem, a.dem_max_m)
    else:
        print("No --dem given: using synthetic Jeju-like terrain")
        elev = synth_dem()
    terrain = Terrain(elev, a.width_km, a.exag)
    terrain.obj.data.materials.append(terrain_material())

    ocean, ocean_mod, water = build_ocean(a.wave_scale)
    build_far_water(water)
    build_sky_and_sun(a.sun_elev)
    orbit, cam = build_camera()
    setup_render(a)

    total = scene.frame_end

    def on_frame(scn, *_):
        f = scn.frame_current
        t = (f - 1) / (total - 1)
        terrain.apply(t)
        ocean_mod.time = f / scn.render.fps * 0.8
        node = water.node_tree.nodes.get(water["noise_node"])
        if node:
            node.inputs["W"].default_value = f / scn.render.fps * 0.4
        s = smoothstep(t)
        orbit.rotation_euler.z = math.radians(-22 + 44 * s)
        cam.location.y = -(72 - 14 * s)

    bpy.app.handlers.frame_change_pre.clear()
    bpy.app.handlers.frame_change_pre.append(on_frame)
    scene.frame_set(a.still or 1)
    on_frame(scene)

    if a.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=a.save_blend)
    if a.still:
        bpy.ops.render.render(write_still=True)
    else:
        bpy.ops.render.render(animation=True)


main()
