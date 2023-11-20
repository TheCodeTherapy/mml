import * as THREE from "three";
import { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

import { TransformableElement } from "./TransformableElement";
import { LoadingInstanceManager } from "../loading/LoadingInstanceManager";
import {
  AttributeHandler,
  parseBoolAttribute,
  parseFloatAttribute,
} from "../utils/attribute-handling";
import { CollideableHelper } from "../utils/CollideableHelper";
import { ModelLoader } from "../utils/ModelLoader";

const defaultModelSrc = "";
const defaultModelAnim = "";
const defaultModelAnimLoop = true;
const defaultModelAnimEnabled = true;
const defaultModelAnimStartTime = 0;
const defaultModelAnimPauseTime = null;
const defaultModelCastShadows = true;

export class Model extends TransformableElement {
  static tagName = "m-model";

  private props = {
    src: defaultModelSrc,
    anim: defaultModelAnim,
    animStartTime: defaultModelAnimStartTime,
    animPauseTime: defaultModelAnimPauseTime as number | null,
    animLoop: defaultModelAnimLoop,
    animEnabled: defaultModelAnimEnabled,
    castShadows: defaultModelCastShadows,
  };

  private static modelLoader = new ModelLoader();
  protected gltfScene: THREE.Object3D | null = null;
  private animationGroup: THREE.AnimationObjectGroup = new THREE.AnimationObjectGroup();
  private animationMixer: THREE.AnimationMixer = new THREE.AnimationMixer(this.animationGroup);
  private documentTimeTickListener: null | { remove: () => void } = null;

  private currentAnimation: THREE.AnimationClip | null = null;
  private currentAnimationAction: THREE.AnimationAction | null = null;
  private collideableHelper = new CollideableHelper(this);
  private latestAnimPromise: Promise<GLTF> | null = null;
  private latestSrcModelPromise: Promise<GLTF> | null = null;
  private registeredParentAttachment: Model | null = null;
  private srcLoadingInstanceManager = new LoadingInstanceManager(
    `${(this.constructor as typeof Model).tagName}.src`,
  );
  private animLoadingInstanceManager = new LoadingInstanceManager(
    `${(this.constructor as typeof Model).tagName}.anim`,
  );

  private static attributeHandler = new AttributeHandler<Model>({
    src: (instance, newValue) => {
      instance.setSrc(newValue);
    },
    anim: (instance, newValue) => {
      instance.setAnim(newValue);
    },
    "cast-shadows": (instance, newValue) => {
      instance.props.castShadows = parseBoolAttribute(newValue, defaultModelCastShadows);
      if (instance.gltfScene) {
        instance.gltfScene.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            node.castShadow = instance.props.castShadows;
          }
        });
      }
    },
    "anim-enabled": (instance, newValue) => {
      instance.props.animEnabled = parseBoolAttribute(newValue, defaultModelAnimEnabled);
    },
    "anim-loop": (instance, newValue) => {
      instance.props.animLoop = parseBoolAttribute(newValue, defaultModelAnimLoop);
    },
    "anim-start-time": (instance, newValue) => {
      instance.props.animStartTime = parseFloatAttribute(newValue, defaultModelAnimStartTime);
    },
    "anim-pause-time": (instance, newValue) => {
      instance.props.animPauseTime = parseFloatAttribute(newValue, defaultModelAnimPauseTime);
    },
  });

  private playAnimation(anim: THREE.AnimationClip) {
    this.currentAnimation = anim;
    if (this.gltfScene) {
      this.animationGroup.remove(this.gltfScene);
    }
    this.animationMixer.stopAllAction();
    const action = this.animationMixer.clipAction(this.currentAnimation);
    action.play();
    this.currentAnimationAction = action;
    if (this.gltfScene) {
      this.animationGroup.add(this.gltfScene);
    }
  }

  public registerAttachment(attachment: THREE.Object3D) {
    this.animationGroup.add(attachment);
    this.updateAnimation(this.getDocumentTime() || 0);
  }

  public unregisterAttachment(attachment: THREE.Object3D) {
    this.animationGroup.remove(attachment);
  }

  static get observedAttributes(): Array<string> {
    return [
      ...TransformableElement.observedAttributes,
      ...Model.attributeHandler.getAttributes(),
      ...CollideableHelper.observedAttributes,
    ];
  }

  constructor() {
    super();
  }

  public parentTransformed(): void {
    this.collideableHelper.parentTransformed();
  }

  public isClickable(): boolean {
    return true;
  }

  private setSrc(newValue: string | null) {
    this.props.src = (newValue || "").trim();
    if (this.gltfScene !== null) {
      this.collideableHelper.removeColliders();
      this.gltfScene.removeFromParent();
      Model.disposeOfGroup(this.gltfScene);
      this.gltfScene = null;
      this.registeredParentAttachment = null;
    }
    if (!this.props.src) {
      this.latestSrcModelPromise = null;
      this.srcLoadingInstanceManager.abortIfLoading();
      return;
    }
    if (!this.isConnected) {
      // Loading will happen when connected
      return;
    }

    const contentSrc = this.contentSrcToContentAddress(this.props.src);
    const srcModelPromise = this.asyncLoadSourceAsset(contentSrc, (loaded, total) => {
      this.srcLoadingInstanceManager.setProgress(loaded / total);
    });
    this.srcLoadingInstanceManager.start(this.getLoadingProgressManager(), contentSrc);
    this.latestSrcModelPromise = srcModelPromise;
    srcModelPromise
      .then((result) => {
        if (this.latestSrcModelPromise !== srcModelPromise || !this.isConnected) {
          // If we've loaded a different model since, or we're no longer connected, dispose of this one
          Model.disposeOfGroup(result.scene);
          return;
        }
        result.scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = this.props.castShadows;
            child.receiveShadow = true;
          }
        });
        this.latestSrcModelPromise = null;
        this.gltfScene = result.scene;
        if (this.gltfScene) {
          this.container.add(this.gltfScene);
          this.collideableHelper.updateCollider(this.gltfScene);

          const parent = this.parentElement;
          if (parent instanceof Model) {
            parent.registerAttachment(this.gltfScene);
            this.registeredParentAttachment = parent;
          }

          if (this.currentAnimation) {
            this.playAnimation(this.currentAnimation);
          }
        }
        this.srcLoadingInstanceManager.finish();
      })
      .catch((err) => {
        console.error("Error loading m-model.src", err);
        this.srcLoadingInstanceManager.error(err);
      });
  }

  private setAnim(newValue: string | null) {
    this.props.anim = (newValue || "").trim();
    if (!this.props.anim) {
      if (this.currentAnimationAction) {
        if (this.gltfScene) {
          this.animationMixer.uncacheRoot(this.gltfScene);
        }
        this.animationMixer.stopAllAction();
      }
      this.latestAnimPromise = null;
      this.currentAnimationAction = null;
      this.currentAnimation = null;
      this.animLoadingInstanceManager.abortIfLoading();
      if (this.gltfScene) {
        this.animationGroup.remove(this.gltfScene);
      }
      return;
    }

    if (this.currentAnimationAction !== null) {
      this.animationMixer.stopAllAction();
      this.currentAnimationAction = null;
    }

    if (!this.isConnected) {
      // Loading will happen when connected
      return;
    }

    const contentSrc = this.contentSrcToContentAddress(this.props.anim);
    const animPromise = this.asyncLoadSourceAsset(contentSrc, (loaded, total) => {
      this.animLoadingInstanceManager.setProgress(loaded / total);
    });
    this.animLoadingInstanceManager.start(this.getLoadingProgressManager(), contentSrc);
    this.latestAnimPromise = animPromise;
    animPromise
      .then((result) => {
        if (this.latestAnimPromise !== animPromise || !this.isConnected) {
          return;
        }
        this.latestAnimPromise = null;
        this.playAnimation(result.animations[0]);
        this.animLoadingInstanceManager.finish();
      })
      .catch((err) => {
        console.error("Error loading m-model.anim", err);
        this.animLoadingInstanceManager.error(err);
      });
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    super.attributeChangedCallback(name, oldValue, newValue);
    Model.attributeHandler.handle(this, name, newValue);
    this.collideableHelper.handle(name, newValue);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.documentTimeTickListener = this.addDocumentTimeTickListener((documentTime) => {
      this.updateAnimation(documentTime);
    });
    if (this.gltfScene) {
      throw new Error("gltfScene should be null upon connection");
    }
    this.setSrc(this.props.src);
    this.setAnim(this.props.anim);
  }

  disconnectedCallback() {
    // stop listening to document time ticking
    if (this.documentTimeTickListener) {
      this.documentTimeTickListener.remove();
      this.documentTimeTickListener = null;
    }
    this.collideableHelper.removeColliders();
    if (this.gltfScene && this.registeredParentAttachment) {
      this.registeredParentAttachment.unregisterAttachment(this.gltfScene);
      this.registeredParentAttachment = null;
    }
    if (this.gltfScene) {
      this.gltfScene.removeFromParent();
      Model.disposeOfGroup(this.gltfScene);
      this.gltfScene = null;
    }
    this.srcLoadingInstanceManager.dispose();
    this.animLoadingInstanceManager.dispose();
    super.disconnectedCallback();
  }

  private updateAnimation(docTimeMs: number) {
    if (this.currentAnimation) {
      if (!this.props.animEnabled) {
        this.animationMixer.stopAllAction();
        this.currentAnimationAction = null;
      } else {
        if (!this.currentAnimationAction) {
          this.currentAnimationAction = this.animationMixer.clipAction(this.currentAnimation);
          this.currentAnimationAction.play();
        }
        let animationTimeMs = docTimeMs - this.props.animStartTime;
        if (docTimeMs < this.props.animStartTime) {
          animationTimeMs = 0;
        } else if (this.props.animPauseTime !== null) {
          if (docTimeMs > this.props.animPauseTime) {
            animationTimeMs = this.props.animPauseTime - this.props.animStartTime;
          }
        }

        if (this.currentAnimation !== null) {
          if (!this.props.animLoop) {
            if (animationTimeMs > this.currentAnimation.duration * 1000) {
              animationTimeMs = this.currentAnimation.duration * 1000;
            }
          }
        }

        this.animationMixer.setTime(animationTimeMs / 1000);
      }
    }
  }

  public getModel(): THREE.Object3D<THREE.Event> | null {
    return this.gltfScene;
  }

  public getCurrentAnimation(): THREE.AnimationClip | null {
    return this.currentAnimation;
  }

  async asyncLoadSourceAsset(
    url: string,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<GLTF> {
    return await Model.modelLoader.loadGltf(url, onProgress);
  }

  private static disposeOfGroup(group: THREE.Object3D) {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          for (const material of mesh.material) {
            Model.disposeOfMaterial(material);
          }
        } else if (mesh.material) {
          Model.disposeOfMaterial(mesh.material);
        }
      }
    });
  }

  private static disposeOfMaterial(material: THREE.Material) {
    material.dispose();
    for (const key of Object.keys(material)) {
      const value = (material as any)[key];
      if (value && typeof value === "object" && "minFilter" in value) {
        value.dispose();
      }
    }
  }
}
